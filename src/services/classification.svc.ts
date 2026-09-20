import { LLMService, createLLMService } from './llm.svc';
import { CLASSIFICATION_SYSTEM_PROMPT } from '../llm/prompts/classification';
import { CLASSIFICATION_RESPONSE_FORMAT } from '../llm/schemas/classification.schema';
import { MessageEntry, RemoteImage, type ClaudeContentBlock, type ClaudeLLMInput, type LLMProviderInput } from '../utils/types';
import { createClosetDB, StyleAnalysisDB } from '../db';
import { StyleEntryTag } from '../db/types';
import { createVoltMemService, isVoltMemWriteTag, type VoltMemService } from './voltmem.svc';
import { createAvatarService, type AvatarService } from './avatar';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { enqueueClosetIdentityFromClassification } from './identity/closetIdentityJob';
import { runClosetIdentityProgress } from './identity/closetIdentityProgress';
import { createRealtimeService } from './realtime.svc';
import { Logger, createLogger } from '../utils/logger.utils';

export type ClosetIdentityEnqueue = {
	enqueue(params: {
		userId: string;
		message: MessageEntry;
		tags: StyleEntryTag[];
		sessionId?: string;
		entryId: string;
	}): Promise<unknown>;
};

export class ClassificationService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB,
		private voltmem: VoltMemService | null = null,
		private avatarService: AvatarService | null = null,
		private identityEnqueue: ClosetIdentityEnqueue | null = null,
		private log: Logger = createLogger({ env: 'dev' })
	) { }

	/**
	 * Extracts R2 image keys from a message, falling back to URLs if keys are unavailable.
	 */
	private extractImages(message: MessageEntry): RemoteImage[] {
		const images: RemoteImage[] = [];

		if (message.remoteImages && message.remoteImages.length > 0) {
			for (const img of message.remoteImages) {
				images.push(img);
			}
		} else if (message.remoteImage) {
			images.push(message.remoteImage);
		}

		return images;
	}

	/**
	 * A lightweight, rule-based classifier that intercepts predictable message structures
	 * to bypass the LLM and save API latency.
	 */
	private async applyHandRolledRules(message: MessageEntry, sessionId?: string, previousMessage?: MessageEntry): Promise<StyleEntryTag[]> {
		const tags: StyleEntryTag[] = [];

		// Rule 1: Message is pure Media with no text. Automatically classify the images as outfit references.
		if (!message.prompt || message.prompt.trim() === '') {
			const images = this.extractImages(message);

			if (images.length > 0) {
				let hasPrimary = false;
				if (sessionId) {
					hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
				}

				tags.push({
					tag: hasPrimary ? 'session_state:alt_outfit_image' : 'session_state:primary_outfit_image',
					payload: {
						images: images,
						summary: hasPrimary ? 'User uploaded auxiliary outfit image(s).' : 'User uploaded the primary outfit image(s).',
						occasion: null, constraint: null, type: null, preference: null
					}
				});
			}
		}

		if (previousMessage?.prompt?.includes("What's the occasion for this outfit?")) {
			tags.push({
				tag: 'session_state:occasion',
				payload: {
					occasion: message.prompt,
					summary: `This the user's response to the question "What's the occasion for this outfit?": ${message.prompt}`,
					constraint: null, type: null, preference: null
				}
			})
		}

		// Rule 2: You could add explicit slash-command handlers here, e.g. /occasion Wedding
		// if (message.prompt?.startsWith('/')) { ... }

		return tags;
	}

	/**
	 * Classifies a message using the LLM and extracts relevant fashion context tags.
	 */
	async classifyMessage(message: MessageEntry, sessionId?: string, previousMessage?: MessageEntry): Promise<StyleEntryTag[]> {
		if (message.role !== 'user') {
			return [];
		}

		if (!message.prompt && (!message.remoteImages || message.remoteImages.length === 0) && !message.remoteImage) {
			return [];
		}

		// 1. Hand-Rolled Pipeline: Parse deterministic triggers
		const manualTags = await this.applyHandRolledRules(message, sessionId, previousMessage);
		if (manualTags.length > 0) {
			return manualTags;
		}

		// 2. LLM Pipeline Fallback: Parse messy natural language
		try {
			// Session State Check: Has a primary outfit already been identified?
			let stateHint = "";
			if (sessionId) {
				const hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
				stateHint = hasPrimary
					? "\n[STATE: A primary outfit has already been identified for this session. Tag any new fashion images as 'session_state:alt_outfit_image'.]"
					: "\n[STATE: No primary outfit has been identified for this session yet. If this message contains a valid outfit image, you MUST tag it as 'session_state:primary_outfit_image'.]";
			}

			// 2. Prepare unified message array for the LLM
			const messagesForLLM: MessageEntry[] = [
				{ role: 'system', prompt: CLASSIFICATION_SYSTEM_PROMPT + stateHint },
				message
			];

			// Leverage provider-specific logic to wait for images, sign URLs, and format for the specific LLM
			const preparedInput = await this.llmService.prepareMessagesForLLM(messagesForLLM);
			const payload = summarizeClassificationPayload(preparedInput);
			this.log.debug('classification_anthropic_payload', {
				last_role: payload.last_role,
				roles: payload.roles.join(','),
				system_chars: payload.system_chars,
				output_format: payload.output_format,
				payload_json: JSON.stringify(payload.messages),
			});

			const res = await this.llmService.generateResponse(
				preparedInput,
				undefined,
				CLASSIFICATION_RESPONSE_FORMAT
			);

			const resultText = res[0]?.text;
			if (!resultText) return [];

			const parsed = JSON.parse(resultText);
			// The LLM might return the array directly or wrapped in a 'tags' property
			const response: StyleEntryTag[] = Array.isArray(parsed) ? parsed : (parsed.tags || []);

			// Post-process: Inject images and enforce primary/alt correctness.
			// The LLM can't see R2 keys and unreliably follows state hints, so we fix both deterministically.
			const images = this.extractImages(message);
			let hasPrimary = false;
			if (sessionId) {
				hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
			}

			for (const tag of response) {
				if (tag.tag === 'session_state:primary_outfit_image' || tag.tag === 'session_state:alt_outfit_image') {
					// Force correct tag based on actual DB state
					if (hasPrimary) {
						tag.tag = 'session_state:alt_outfit_image';
					}

					// Inject actual images from the original message
					if (images.length > 0) {
						tag.payload = { ...tag.payload, images };
					}
				}
			}

			return response;
		} catch (e) {
			this.log.error('classification_failed', { session_id: sessionId }, e);
			return [];
		}
	}

	/**
	 * Runs classification in the background using ctx.waitUntil to avoid blocking the main response.
	 * @param previousMessage - Pass the previous message for context. Pass `null` to explicitly indicate
	 *   no previous message exists. Pass `undefined` (or omit) to resolve from DB automatically.
	 * @param userId - D1 users.id used as VoltMem namespace for cross-session write-through.
	 */
	async tagEntryInBackground(
		entryId: string,
		message: MessageEntry,
		ctx: ExecutionContext,
		sessionId?: string,
		previousMessage?: MessageEntry | null,
		userId?: string
	) {
		ctx.waitUntil((async () => {
			try {
				// null = caller knows there's no previous message, undefined = resolve from DB
				let prevMsg: MessageEntry | undefined = previousMessage ?? undefined;
				if (previousMessage === undefined && sessionId) {
					const { messages: recent } = await this.styleAnalysisDB.getSessionMessages(sessionId, { page: 1, pageSize: 2 });
					const prevEntry = recent.length > 1 ? recent[1] : undefined;
					if (prevEntry) {
						prevMsg = {
							role: prevEntry.role as 'user' | 'assistant' | 'system',
							prompt: prevEntry.content || undefined
						};
					}
				}

				const tags = await this.classifyMessage(message, sessionId, prevMsg);
				if (tags.length > 0) {
					await this.styleAnalysisDB.addEntryTags(entryId, tags);
					await this.writeThroughVoltMem(userId, tags);
					await this.maybeEnqueueAvatar(userId, message, tags);
					await this.maybeEnqueueIdentity(userId, message, tags, sessionId, entryId);
				}
			} catch (e) {
				console.trace('Background classification failed:', e);
			}
		})());
	}

	/**
	 * Persist text prefs/constraints/occasions to VoltMem (fail-open, no outfit images).
	 */
	private async writeThroughVoltMem(userId: string | undefined, tags: StyleEntryTag[]) {
		if (!userId || !this.voltmem) return;

		for (const tag of tags) {
			if (!isVoltMemWriteTag(tag.tag)) continue;
			const summary = typeof tag.payload?.summary === 'string' ? tag.payload.summary : '';
			if (!summary.trim()) continue;
			await this.voltmem.rememberFromTag(userId, tag.tag, summary);
		}
	}

	/**
	 * First outfit-tagged tip photo may seed a user twin. Fail-open; never blocks classification.
	 */
	private async maybeEnqueueAvatar(
		userId: string | undefined,
		message: MessageEntry,
		tags: StyleEntryTag[]
	) {
		if (!userId || !this.avatarService) return;

		const hasOutfitImage = tags.some(
			(tag) =>
				tag.tag === 'session_state:primary_outfit_image' ||
				tag.tag === 'session_state:alt_outfit_image'
		);
		if (!hasOutfitImage) return;

		const image = this.resolveOutfitImage(message, tags);
		if (!image) return;

		try {
			await this.avatarService.maybeEnqueueFromOutfitImage({
				userId,
				imageKey: image.key,
				imageUrl: image.url,
			});
		} catch (e) {
			console.trace('Background avatar enqueue failed:', e);
		}
	}

	/**
	 * Outfit-tagged photos enqueue extract+identity. Fail-open; never blocks classification.
	 */
	private async maybeEnqueueIdentity(
		userId: string | undefined,
		message: MessageEntry,
		tags: StyleEntryTag[],
		sessionId: string | undefined,
		entryId: string
	) {
		if (!userId || !this.identityEnqueue) return;

		try {
			await this.identityEnqueue.enqueue({
				userId,
				message,
				tags,
				sessionId,
				entryId,
			});
		} catch (e) {
			console.trace('Background identity enqueue failed:', e);
		}
	}

	private resolveOutfitImage(message: MessageEntry, tags: StyleEntryTag[]): RemoteImage | null {
		for (const tag of tags) {
			if (
				tag.tag !== 'session_state:primary_outfit_image' &&
				tag.tag !== 'session_state:alt_outfit_image'
			) {
				continue;
			}
			const payloadImages = tag.payload?.images as RemoteImage[] | undefined;
			const fromPayload = this.withResolvedKey(payloadImages?.[0]);
			if (fromPayload) return fromPayload;
		}

		return this.withResolvedKey(this.extractImages(message)[0]);
	}

	private withResolvedKey(image: RemoteImage | undefined): RemoteImage | null {
		if (!image?.url && !image?.key) return null;

		let key = image.key;
		if (!key && image.url) {
			try {
				key = image.url.startsWith('http') ? new URL(image.url).pathname.slice(1) : image.url;
			} catch {
				key = image.url;
			}
		}

		if (!key) return null;
		return { url: image.url ?? '', key, blurHash: image.blurHash };
	}
}

/**
 * Factory function to create the ClassificationService.
 */
export const createClassificationService = (database: D1Database, env?: Env) => {
	// Use the dedicated classification model configuration (usually a fast/cheap 'Mini' model)
	const llmService = createLLMService({ useCase: ModelUseCase.CLASSIFICATION, provider: ModelProvider.CLAUDE });
	const styleAnalysisDB = new StyleAnalysisDB(database);
	const voltmem = env ? createVoltMemService(env) : null;
	const avatarService = env ? createAvatarService(env) : null;
	const identityEnqueue: ClosetIdentityEnqueue | null = env
		? {
				enqueue: (params) => {
					const closet = createClosetDB(env.GOSTYLENS_DB);
					const log = createLogger({ env: env.ENV_NAME });
					return enqueueClosetIdentityFromClassification({
						queue: env.CLOSET_IDENTITY_QUEUE,
						closet,
						log,
						...params,
						syncProgress: (userId) =>
							runClosetIdentityProgress({
								userId,
								closet,
								realtime: createRealtimeService(),
								log,
								queue: env.CLOSET_IDENTITY_QUEUE,
								scheduleOnRetry: true,
							}),
					});
				},
			}
		: null;
	const log = createLogger({ env: env?.ENV_NAME ?? 'dev' }).child({ service: 'classification' });
	return new ClassificationService(llmService, styleAnalysisDB, voltmem, avatarService, identityEnqueue, log);
};

function summarizeClassificationPayload(input: LLMProviderInput) {
	const claude = input as ClaudeLLMInput;
	const messages = Array.isArray(claude.messages) ? claude.messages : [];
	const last = messages[messages.length - 1];
	return {
		last_role: last?.role ?? null,
		roles: messages.map((message) => message.role),
		system_chars: classificationSystemChars(claude.system),
		output_format: CLASSIFICATION_RESPONSE_FORMAT.type,
		messages: messages.map(summarizeClassificationMessage),
	};
}

function summarizeClassificationMessage(message: ClaudeLLMInput['messages'][number]) {
	if (typeof message.content === 'string') {
		return { role: message.role, text: message.content, images: [] as string[] };
	}

	const text = message.content
		.filter((block): block is Extract<ClaudeContentBlock, { type: 'text' }> => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
	const images = message.content.flatMap((block) => {
		if (block.type !== 'image') return [];
		if (block.source.type === 'url') return [stripUrlQuery(block.source.url)];
		return [`base64:${block.source.media_type}`];
	});
	return { role: message.role, text, images };
}

function classificationSystemChars(system: ClaudeLLMInput['system']): number {
	if (!system) return 0;
	if (typeof system === 'string') return system.length;
	return system.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
}

function stripUrlQuery(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url;
	}
}
