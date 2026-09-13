import type { ClosetDB, ClosetIdentityJobRow } from '../../db/closet';
import type { StyleEntryTag } from '../../db/types';
import type { OutfitExtractionResponse } from '../../types';
import type { Logger } from '../../utils/logger.utils';
import type { MessageEntry, RemoteImage } from '../../utils/types';
import { IdentityBusyError, type ProcessOutfitImageParams, type ProcessOutfitImageResult } from './processOutfitImage';

export const IDENTITY_BUSY_RETRY_SECONDS = 30;
export const IDENTITY_ERROR_RETRY_SECONDS = 15;

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
};

export type ClosetIdentityEnqueueStore = Pick<ClosetDB, 'tryInsertIdentityJob' | 'getIdentityJob'>;

export type ClosetIdentityRunStore = Pick<
	ClosetDB,
	'getIdentityJob' | 'saveIdentityJobExtraction' | 'markIdentityJobDone'
>;

export type ClosetIdentityRunDecision =
	| { action: 'ack'; reason: 'done' | 'invalid' | 'completed' }
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
}): Promise<{ enqueued: number; skipped: number }> {
	let enqueued = 0;
	let skipped = 0;

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

		const payload: ClosetIdentityQueueJob = {
			kind: 'closet_identity',
			userId: params.userId,
			imageKey: image.key,
			imageUrl: image.url,
			sessionId: params.sessionId,
			entryId: params.entryId,
			source: 'session',
		};
		await params.queue.send(payload);
		enqueued += 1;
		params.log.info('closet_identity_enqueued', {
			user_id: params.userId,
			image_key: image.key,
			session_id: params.sessionId,
			entry_id: params.entryId,
		});
	}

	return { enqueued, skipped };
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
}): Promise<{ enqueued: number; skipped: number }> {
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
	});
}

export async function runClosetIdentityJob(params: {
	job: ClosetIdentityQueueJob;
	closet: ClosetIdentityRunStore;
	process: (input: ProcessOutfitImageParams) => Promise<ProcessOutfitImageResult | null>;
	log: Logger;
}): Promise<ClosetIdentityRunDecision> {
	const userId = params.job.userId?.trim();
	const imageKey = params.job.imageKey?.trim();
	const imageUrl = params.job.imageUrl?.trim();
	if (!userId || !imageKey || !imageUrl) {
		params.log.warn('closet_identity_invalid_job', {
			user_id: userId,
			image_key: imageKey,
		});
		return { action: 'ack', reason: 'invalid' };
	}

	const stored = await params.closet.getIdentityJob(userId, imageKey);
	if (stored?.status === 'done') {
		return { action: 'ack', reason: 'done' };
	}

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
			params.log.warn('closet_identity_extract_empty', { user_id: userId, image_key: imageKey });
			return { action: 'retry', delaySeconds: IDENTITY_ERROR_RETRY_SECONDS, reason: 'extract_empty' };
		}
		await params.closet.markIdentityJobDone(userId, imageKey, result.outfit_id);
		params.log.info('closet_identity_completed', {
			user_id: userId,
			image_key: imageKey,
			outfit_id: result.outfit_id,
		});
		return { action: 'ack', reason: 'completed' };
	} catch (err) {
		if (isIdentityBusyError(err)) {
			params.log.info('closet_identity_busy', { user_id: userId, image_key: imageKey });
			return { action: 'retry', delaySeconds: IDENTITY_BUSY_RETRY_SECONDS, reason: 'busy' };
		}
		params.log.error('closet_identity_failed', { user_id: userId, image_key: imageKey }, err);
		return { action: 'retry', delaySeconds: IDENTITY_ERROR_RETRY_SECONDS, reason: 'error' };
	}
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
