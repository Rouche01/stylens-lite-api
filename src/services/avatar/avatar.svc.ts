import { AvatarsDB, createAvatarsDB } from '../../db/avatars';
import { LLMService, createLLMService } from '../llm.svc';
import { ModelProvider, ModelUseCase } from '../model_config.svc';
import { AVATAR_FRAMING_RESPONSE_FORMAT } from '../../llm/schemas/avatar_framing.schema';
import { AVATAR_FRAMING_SYSTEM_PROMPT, AVATAR_FRAMING_USER_PROMPT } from '../../llm/prompts/avatar_framing';
import { AvatarImageError, AvatarImageProvider, createAvatarImageProvider } from './providers';
import { fetchImageAsArrayBuffer } from '../../utils/assets.utils';
import { Logger, createLogger } from '../../utils/logger.utils';
import { MessageEntry } from '../../utils/types';

export type AvatarGenerationJob = {
	avatarId: string;
	userId: string;
	sourceImageKey: string;
	sourceImageUrl?: string;
};

export type MaybeEnqueueResult =
	| { status: 'skipped'; reason: 'already_active' | 'claim_lost' | 'gate_failed' }
	| { status: 'rejected_framing'; avatarId: string }
	| { status: 'enqueued'; avatarId: string };

type FramingGateResult = {
	is_full_body: boolean;
	confidence: 'high' | 'medium' | 'low';
	reason: string;
};

export class AvatarService {
	constructor(
		private avatarsDB: AvatarsDB,
		private llmService: LLMService,
		private imageProvider: AvatarImageProvider,
		private queue: Queue<AvatarGenerationJob>,
		private bucket: R2Bucket,
		private log: Logger
	) {}

	async maybeEnqueueFromOutfitImage(params: {
		userId: string;
		imageKey: string;
		imageUrl: string;
	}): Promise<MaybeEnqueueResult> {
		const { userId, imageKey, imageUrl } = params;
		const log = this.log.child({ user_id: userId, source_image_key: imageKey });

		const existing = await this.avatarsDB.getActiveAvatar(userId);
		if (existing) {
			log.info('avatar_enqueue_skipped', { reason: 'already_active', avatar_id: existing.id });
			return { status: 'skipped', reason: 'already_active' };
		}

		let framing: FramingGateResult | null = null;
		try {
			framing = await this.evaluateFullBodyFraming({ imageKey, imageUrl });
		} catch (err) {
			log.warn('avatar_framing_gate_failed', { user_id: userId }, err);
			return { status: 'skipped', reason: 'gate_failed' };
		}

		const passes = framing.is_full_body && framing.confidence !== 'low';
		if (!passes) {
			const rejected = await this.avatarsDB.insertRejectedFraming({
				userId,
				sourceImageKey: imageKey,
				sourceImageUrl: imageUrl,
				framingConfidence: framing.confidence,
				error: framing.reason,
			});
			log.info('avatar_framing_rejected', {
				avatar_id: rejected.id,
				confidence: framing.confidence,
				reason: framing.reason,
			});
			return { status: 'rejected_framing', avatarId: rejected.id };
		}

		const claimed = await this.avatarsDB.claimPending({
			userId,
			sourceImageKey: imageKey,
			sourceImageUrl: imageUrl,
			framingConfidence: framing.confidence,
			model: this.imageProvider.model,
		});

		if (!claimed) {
			log.info('avatar_enqueue_skipped', { reason: 'claim_lost' });
			return { status: 'skipped', reason: 'claim_lost' };
		}

		try {
			await this.queue.send({
				avatarId: claimed.id,
				userId,
				sourceImageKey: imageKey,
				sourceImageUrl: imageUrl,
			});
		} catch (err) {
			await this.avatarsDB.markFailed(claimed.id, err instanceof Error ? err.message : String(err));
			throw err;
		}

		log.info('avatar_enqueued', { avatar_id: claimed.id });
		return { status: 'enqueued', avatarId: claimed.id };
	}

	async generate(job: AvatarGenerationJob): Promise<void> {
		const log = this.log.child({
			user_id: job.userId,
			avatar_id: job.avatarId,
			source_image_key: job.sourceImageKey,
		});

		const row = await this.avatarsDB.getById(job.avatarId);
		if (!row) {
			log.warn('avatar_generate_skipped', { reason: 'missing_row' });
			return;
		}
		if (row.status === 'ready') {
			log.info('avatar_generate_skipped', { reason: 'already_ready' });
			return;
		}
		if (row.status !== 'pending') {
			log.info('avatar_generate_skipped', { reason: 'not_pending', status: row.status });
			return;
		}

		const imageBuffer = await this.loadSourceImage(job.sourceImageKey, job.sourceImageUrl ?? row.source_image_url);
		const twin = await this.imageProvider.generateTwin(imageBuffer);
		const avatarImageKey = `avatars/${job.userId}/${job.avatarId}.png`;

		await this.bucket.put(avatarImageKey, twin.pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});

		await this.avatarsDB.markReady(job.avatarId, avatarImageKey, twin.model);
		log.info('avatar_ready', { avatar_image_key: avatarImageKey, model: twin.model });
	}

	async failGeneration(avatarId: string, err: unknown): Promise<void> {
		const message = err instanceof Error ? err.message : String(err);
		await this.avatarsDB.markFailed(avatarId, message);
		this.log.warn('avatar_marked_failed', { avatar_id: avatarId, error_message: message }, err);
	}

	isRetryableGenerateError(err: unknown): boolean {
		if (err instanceof AvatarImageError) {
			return err.isRetryable;
		}
		return true;
	}

	private async evaluateFullBodyFraming(params: {
		imageKey: string;
		imageUrl: string;
	}): Promise<FramingGateResult> {
		const messages: MessageEntry[] = [
			{ role: 'system', prompt: AVATAR_FRAMING_SYSTEM_PROMPT },
			{
				role: 'user',
				prompt: AVATAR_FRAMING_USER_PROMPT,
				remoteImage: { url: params.imageUrl, key: params.imageKey },
			},
		];

		const prepared = await this.llmService.prepareMessagesForLLM(messages);
		const outputs = await this.llmService.generateResponse(prepared, undefined, AVATAR_FRAMING_RESPONSE_FORMAT);
		const parsed = LLMService.extractJSON<FramingGateResult>(outputs);

		if (!parsed || typeof parsed.is_full_body !== 'boolean') {
			throw new Error('Avatar framing gate returned invalid JSON');
		}

		return {
			is_full_body: parsed.is_full_body,
			confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low',
			reason: parsed.reason || 'no reason',
		};
	}

	private async loadSourceImage(imageKey: string, imageUrl?: string | null): Promise<ArrayBuffer> {
		const object = await this.bucket.get(imageKey);
		if (object) {
			return object.arrayBuffer();
		}
		if (imageUrl) {
			return fetchImageAsArrayBuffer(imageUrl);
		}
		throw new Error(`Source image not found in R2: ${imageKey}`);
	}
}

export const createAvatarService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'avatar' });
	return new AvatarService(
		createAvatarsDB(envBindings.GOSTYLENS_DB),
		createLLMService({ useCase: ModelUseCase.AVATAR_FRAMING, provider: ModelProvider.CLAUDE }),
		createAvatarImageProvider(envBindings),
		envBindings.AVATAR_GENERATION_QUEUE,
		envBindings.OUTFIT_PHOTOS_BUCKET,
		logger
	);
};
