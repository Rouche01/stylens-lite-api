import type { ClosetDB, ClosetIdentityJobRow } from '../../../db/closet';
import type { StyleEntryTag } from '../../../db/types';
import type { OutfitExtractionResponse } from '../../../types';
import type { Logger } from '../../../utils/logger.utils';
import type { MessageEntry, RemoteImage } from '../../../utils/types';
import { buildIdentityRunArtifact, type IdentityRunArtifact } from '../logging/runArtifact';
import {
	IdentityRunLogEvents,
	identityRunChildContext,
	identityRunCompletedLogContext,
	mintIdentityRunId,
	summarizeIdentityRunItems,
} from '../logging/runLogging';
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
	/** Optional local-review hook (e.g. persist JSON artifact when ENV_NAME=dev). Fail-open. */
	onRunCompleted?: (artifact: IdentityRunArtifact) => Promise<unknown>;
	envName?: string;
}): Promise<ClosetIdentityRunDecision> {
	const userId = params.job.userId?.trim();
	const imageKey = params.job.imageKey?.trim();
	const imageUrl = params.job.imageUrl?.trim();
	const sessionId = params.job.sessionId?.trim();
	const entryId = params.job.entryId?.trim();
	if (!userId || !imageKey || !imageUrl) {
		params.log.warn('closet_identity_invalid_job', {
			user_id: userId,
			image_key: imageKey,
			identity_run_id: params.job.identityRunId,
		});
		if (userId && imageKey) {
			await params.closet.markIdentityJobStatus(userId, imageKey, 'failed');
			await params.closet.touchIdentityProgressActivity(userId);
		}
		return { action: 'ack', reason: 'invalid' };
	}

	const identityRunId = resolveIdentityRunId(params.job.identityRunId, params.log, {
		user_id: userId,
		image_key: imageKey,
	});
	const runLog = params.log.child(
		identityRunChildContext({
			identity_run_id: identityRunId,
			user_id: userId,
			image_key: imageKey,
			session_id: sessionId,
			entry_id: entryId,
		})
	);

	const stored = await params.closet.getIdentityJob(userId, imageKey);
	if (stored?.status === 'done') {
		return { action: 'ack', reason: 'done' };
	}

	const attempts = params.attempts ?? 1;
	await params.closet.markIdentityJobStatus(userId, imageKey, 'running');
	await params.closet.touchIdentityProgressActivity(userId);

	runLog.info(IdentityRunLogEvents.JOB_STARTED, {
		attempts,
		session_id: sessionId,
		entry_id: entryId,
	});

	try {
		const result = await params.process({
			userId,
			imageKey,
			imageUrl,
			identityRunId,
			cachedExtraction: parseCachedExtraction(stored),
			onExtracted: async (extraction) => {
				await params.closet.saveIdentityJobExtraction(userId, imageKey, JSON.stringify(extraction));
			},
		});
		if (!result) {
			runLog.warn('closet_identity_extract_empty', { attempts });
			return failOrRetry(params, runLog, userId, imageKey, attempts, 'extract_empty', identityRunId);
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
			runLog.warn(
				'closet_catalog_broadcast_failed',
				{ outfit_id: result.outfit_id },
				err
			);
		}
		const summary = summarizeIdentityRunItems(result.items);
		runLog.info(
			IdentityRunLogEvents.JOB_COMPLETED,
			identityRunCompletedLogContext({
				identity_run_id: identityRunId,
				user_id: userId,
				image_key: imageKey,
				outfit_id: result.outfit_id,
				summary,
				session_id: sessionId,
				entry_id: entryId,
			})
		);
		if (params.onRunCompleted) {
			try {
				await params.onRunCompleted(
					buildIdentityRunArtifact({
						identity_run_id: identityRunId,
						envName: params.envName ?? 'dev',
						source: 'queue',
						user_id: userId,
						image_key: imageKey,
						outfit_id: result.outfit_id,
						summary,
						session_id: sessionId,
						entry_id: entryId,
					})
				);
			} catch (err) {
				runLog.debug('identity_run_artifact_hook_failed', {
					identity_run_id: identityRunId,
					error_message: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return { action: 'ack', reason: 'completed' };
	} catch (err) {
		if (isIdentityBusyError(err)) {
			runLog.info(IdentityRunLogEvents.JOB_BUSY, { attempts });
			return failOrRetry(params, runLog, userId, imageKey, attempts, 'busy', identityRunId);
		}
		runLog.error(IdentityRunLogEvents.JOB_FAILED, { attempts }, err);
		return failOrRetry(params, runLog, userId, imageKey, attempts, 'error', identityRunId);
	}
}

function resolveIdentityRunId(
	fromJob: string | undefined,
	log: Logger,
	context: { user_id: string; image_key: string }
): string {
	const existing = fromJob?.trim();
	if (existing) return existing;
	const identityRunId = mintIdentityRunId();
	log.info(IdentityRunLogEvents.RUN_ID_MINTED_AT_CONSUMER, {
		...context,
		identity_run_id: identityRunId,
	});
	return identityRunId;
}

async function failOrRetry(
	params: {
		closet: ClosetIdentityRunStore;
		log: Logger;
	},
	runLog: Logger,
	userId: string,
	imageKey: string,
	attempts: number,
	reason: 'busy' | 'extract_empty' | 'error',
	identityRunId: string
): Promise<ClosetIdentityRunDecision> {
	if (attempts >= IDENTITY_FAIL_AFTER_ATTEMPTS) {
		await params.closet.markIdentityJobStatus(userId, imageKey, 'failed');
		await params.closet.touchIdentityProgressActivity(userId);
		runLog.warn(IdentityRunLogEvents.JOB_GAVE_UP, {
			attempts,
			reason,
			identity_run_id: identityRunId,
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
