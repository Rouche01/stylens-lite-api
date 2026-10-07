import type { ClosetDB, ClosetIdentityJobRow } from '../../../db/closet';
import type { StyleEntryTag } from '../../../db/types';
import type { OutfitExtractionResponse } from '../../../types';
import type { Logger } from '../../../utils/logger.utils';
import type { MessageEntry, RemoteImage } from '../../../utils/types';
import { IdentityRunLogEvents, mintIdentityRunId } from '../logging/runLogging';
import { IdentityBusyError } from '../write/errors';
import type { ProcessOutfitImageParams, ProcessOutfitImageResult } from '../write/types';
import type { ClosetCatalogNotifyItem } from '../../../utils/closet_browse';

export const IDENTITY_BUSY_RETRY_SECONDS = 30;
export const IDENTITY_ERROR_RETRY_SECONDS = 15;
/** After this many queue deliveries, ack as failed so the processing indicator can stop. */
export const IDENTITY_FAIL_AFTER_ATTEMPTS = 5;

const OUTFIT_IMAGE_TAGS = new Set<StyleEntryTag['tag']>([
	'session_state:primary_outfit_image',
	'session_state:alt_outfit_image',
]);

export type ClosetIdentityQueueJob = {
	kind: 'closet_identity';
	userId: string;
	imageKey: string;
	imageUrl: string;
	sessionId?: string;
	entryId?: string;
	source: 'session';
	/** Correlates enqueue → consumer → process logs. Minted at enqueue; optional for older payloads. */
	identityRunId?: string;
};

export type ClosetIdentityEnqueueResult = {
	enqueued: number;
	skipped: number;
	identity_run_ids: string[];
	image_keys: string[];
};

export type ClosetIdentityEnqueueStore = Pick<
	ClosetDB,
	'tryInsertIdentityJob' | 'getIdentityJob' | 'touchIdentityProgressActivity'
>;

export type ClosetIdentityRunStore = Pick<
	ClosetDB,
	| 'getIdentityJob'
	| 'saveIdentityJobExtraction'
	| 'markIdentityJobDone'
	| 'markIdentityJobStatus'
	| 'touchIdentityProgressActivity'
>;

export type ClosetIdentityRunDecision =
	| { action: 'ack'; reason: 'done' | 'invalid' | 'completed' | 'failed' }
	| { action: 'retry'; delaySeconds: number; reason: 'busy' | 'extract_empty' | 'error' };

export function collectOutfitIdentityImages(message: MessageEntry, tags: StyleEntryTag[]): RemoteImage[] {
	if (!tags.some((tag) => OUTFIT_IMAGE_TAGS.has(tag.tag))) {
		return [];
	}

	const seen = new Set<string>();
	const images: RemoteImage[] = [];
	const push = (image: RemoteImage | undefined) => {
		const resolved = withResolvedKey(image);
		if (!resolved || seen.has(resolved.key)) return;
		seen.add(resolved.key);
		images.push(resolved);
	};

	for (const tag of tags) {
		if (!OUTFIT_IMAGE_TAGS.has(tag.tag)) continue;
		const payloadImages = tag.payload?.images as RemoteImage[] | undefined;
		if (!Array.isArray(payloadImages)) continue;
		for (const image of payloadImages) {
			push(image);
		}
	}

	if (message.remoteImages && message.remoteImages.length > 0) {
		for (const image of message.remoteImages) {
			push(image);
		}
	} else {
		push(message.remoteImage);
	}

	return images;
}

export async function enqueueClosetIdentityJobs(params: {
	queue: Pick<Queue, 'send'>;
	closet: ClosetIdentityEnqueueStore;
	log: Logger;
	userId: string;
	images: RemoteImage[];
	sessionId?: string;
	entryId?: string;
	source?: ClosetIdentityQueueJob['source'];
	syncProgress?: (userId: string) => Promise<unknown>;
}): Promise<ClosetIdentityEnqueueResult> {
	let skipped = 0;
	const payloads: ClosetIdentityQueueJob[] = [];

	for (const image of params.images) {
		if (!image.key || !image.url) {
			skipped += 1;
			continue;
		}

		await params.closet.tryInsertIdentityJob({
			userId: params.userId,
			imageKey: image.key,
			imageUrl: image.url,
			sessionId: params.sessionId,
			entryId: params.entryId,
			source: params.source ?? 'session',
		});

		const job = await params.closet.getIdentityJob(params.userId, image.key);
		if (!job || job.status === 'done') {
			skipped += 1;
			continue;
		}

		payloads.push({
			kind: 'closet_identity',
			userId: params.userId,
			imageKey: image.key,
			imageUrl: image.url,
			sessionId: params.sessionId,
			entryId: params.entryId,
			source: 'session',
			identityRunId: mintIdentityRunId(),
		});
	}

	if (payloads.length > 0) {
		await params.closet.touchIdentityProgressActivity(params.userId);
		try {
			await params.syncProgress?.(params.userId);
		} catch (err) {
			params.log.warn('closet_identity_progress_sync_failed', { user_id: params.userId }, err);
		}
	}

	for (const payload of payloads) {
		await params.queue.send(payload);
		params.log.info(IdentityRunLogEvents.ENQUEUED_IMAGE, {
			user_id: params.userId,
			image_key: payload.imageKey,
			session_id: params.sessionId,
			entry_id: params.entryId,
			identity_run_id: payload.identityRunId,
		});
	}

	return {
		enqueued: payloads.length,
		skipped,
		identity_run_ids: payloads.map((p) => p.identityRunId!).filter(Boolean),
		image_keys: payloads.map((p) => p.imageKey),
	};
}

export async function enqueueClosetIdentityFromClassification(params: {
	queue: Pick<Queue, 'send'>;
	closet: ClosetIdentityEnqueueStore;
	log: Logger;
	userId: string;
	message: MessageEntry;
	tags: StyleEntryTag[];
	sessionId?: string;
	entryId: string;
	syncProgress?: (userId: string) => Promise<unknown>;
}): Promise<ClosetIdentityEnqueueResult> {
	const images = collectOutfitIdentityImages(params.message, params.tags);
	return enqueueClosetIdentityJobs({
		queue: params.queue,
		closet: params.closet,
		log: params.log,
		userId: params.userId,
		images,
		sessionId: params.sessionId,
		entryId: params.entryId,
		source: 'session',
		syncProgress: params.syncProgress,
	});
}

export async function runClosetIdentityJob(params: {
	job: ClosetIdentityQueueJob;
	closet: ClosetIdentityRunStore;
	process: (input: ProcessOutfitImageParams) => Promise<ProcessOutfitImageResult | null>;
	log: Logger;
	attempts?: number;
	notifyCatalog?: (params: {
		userId: string;
		outfitId: string;
		items: readonly ClosetCatalogNotifyItem[];
	}) => Promise<unknown>;
}): Promise<ClosetIdentityRunDecision> {
	const userId = params.job.userId?.trim();
	const imageKey = params.job.imageKey?.trim();
	const imageUrl = params.job.imageUrl?.trim();
	if (!userId || !imageKey || !imageUrl) {
		params.log.warn('closet_identity_invalid_job', {
			user_id: userId,
			image_key: imageKey,
		});
		if (userId && imageKey) {
			await params.closet.markIdentityJobStatus(userId, imageKey, 'failed');
			await params.closet.touchIdentityProgressActivity(userId);
		}
		return { action: 'ack', reason: 'invalid' };
	}

	const stored = await params.closet.getIdentityJob(userId, imageKey);
	if (stored?.status === 'done') {
		return { action: 'ack', reason: 'done' };
	}

	const attempts = params.attempts ?? 1;
	await params.closet.markIdentityJobStatus(userId, imageKey, 'running');
	await params.closet.touchIdentityProgressActivity(userId);

	try {
		const result = await params.process({
			userId,
			imageKey,
			imageUrl,
			cachedExtraction: parseCachedExtraction(stored),
			onExtracted: async (extraction) => {
				await params.closet.saveIdentityJobExtraction(userId, imageKey, JSON.stringify(extraction));
			},
		});
		if (!result) {
			params.log.warn('closet_identity_extract_empty', { user_id: userId, image_key: imageKey, attempts });
			return failOrRetry(params, userId, imageKey, attempts, 'extract_empty');
		}
		await params.closet.markIdentityJobDone(userId, imageKey, result.outfit_id);
		await params.closet.touchIdentityProgressActivity(userId);
		try {
			await params.notifyCatalog?.({
				userId,
				outfitId: result.outfit_id,
				items: result.items,
			});
		} catch (err) {
			params.log.warn(
				'closet_catalog_broadcast_failed',
				{ user_id: userId, outfit_id: result.outfit_id },
				err
			);
		}
		params.log.info('closet_identity_completed', {
			user_id: userId,
			image_key: imageKey,
			outfit_id: result.outfit_id,
		});
		return { action: 'ack', reason: 'completed' };
	} catch (err) {
		if (isIdentityBusyError(err)) {
			params.log.info('closet_identity_busy', { user_id: userId, image_key: imageKey, attempts });
			return failOrRetry(params, userId, imageKey, attempts, 'busy');
		}
		params.log.error('closet_identity_failed', { user_id: userId, image_key: imageKey, attempts }, err);
		return failOrRetry(params, userId, imageKey, attempts, 'error');
	}
}

async function failOrRetry(
	params: {
		closet: ClosetIdentityRunStore;
		log: Logger;
	},
	userId: string,
	imageKey: string,
	attempts: number,
	reason: 'busy' | 'extract_empty' | 'error'
): Promise<ClosetIdentityRunDecision> {
	if (attempts >= IDENTITY_FAIL_AFTER_ATTEMPTS) {
		await params.closet.markIdentityJobStatus(userId, imageKey, 'failed');
		await params.closet.touchIdentityProgressActivity(userId);
		params.log.warn('closet_identity_gave_up', {
			user_id: userId,
			image_key: imageKey,
			attempts,
			reason,
		});
		return { action: 'ack', reason: 'failed' };
	}

	await params.closet.markIdentityJobStatus(userId, imageKey, 'queued');
	await params.closet.touchIdentityProgressActivity(userId);
	return {
		action: 'retry',
		delaySeconds: reason === 'busy' ? IDENTITY_BUSY_RETRY_SECONDS : IDENTITY_ERROR_RETRY_SECONDS,
		reason,
	};
}

function parseCachedExtraction(row: ClosetIdentityJobRow | null | undefined): OutfitExtractionResponse | undefined {
	if (!row?.extraction_json) return undefined;
	try {
		const parsed = JSON.parse(row.extraction_json) as OutfitExtractionResponse;
		if (parsed && Array.isArray(parsed.items)) {
			return parsed;
		}
	} catch {
		// Fall through and re-extract.
	}
	return undefined;
}

function withResolvedKey(image: RemoteImage | undefined): RemoteImage | null {
	if (!image?.url && !image?.key) return null;

	let key = image.key;
	if (!key && image.url) {
		try {
			key = image.url.startsWith('http') ? new URL(image.url).pathname.slice(1) : image.url;
		} catch {
			key = image.url;
		}
	}

	if (!key || !image.url) return null;
	return { url: image.url, key, blurHash: image.blurHash };
}

function isIdentityBusyError(err: unknown): boolean {
	return err instanceof IdentityBusyError || (err instanceof Error && err.name === 'IdentityBusyError');
}
