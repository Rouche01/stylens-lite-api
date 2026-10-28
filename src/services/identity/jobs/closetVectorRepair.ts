import type { ClosetDB, ClosetItemMatchWithOutfit } from '../../../db/closet';
import type { Logger } from '../../../utils/logger.utils';
import { preparedFromProbeEmbed } from '../encode/probeEmbed';
import { closetItemVectorId } from '../encode/vectorize.store';
import type { CropEncoder, PreparedClosetCrop } from '../encode/cropEncoder';

export const VECTOR_REPAIR_MAX_ATTEMPTS = 10;
export const VECTOR_REPAIR_BACKFILL_DELAY_SECONDS = 60;
export const VECTOR_REPAIR_RETRY_SECONDS = [2, 5, 15, 30, 60, 60, 60, 60, 60] as const;
export const VECTOR_BACKFILL_SCAN_LIMIT = 200;
export const VECTOR_BACKFILL_GET_BY_IDS_CHUNK = 100;
export const VECTOR_BACKFILL_ORPHAN_MATCH_LIMIT = 25;

export type ClosetVectorRepairJob = {
	kind: 'closet_vector_repair';
	closetItemId: string;
	matchId: string;
	userId: string;
};

export type ClosetVectorBackfillJob = {
	kind: 'closet_vector_backfill';
	closetItemId?: string;
	mode?: 'scan';
};

export type ClosetVectorRepairDecision =
	| { action: 'ack'; reason: 'stamped' | 'already_stamped' | 'missing_item' | 'invalid' | 'exhausted' | 'scanned' }
	| { action: 'retry'; delaySeconds: number };

export type ClosetVectorRepairStore = Pick<
	ClosetDB,
	| 'getClosetItemSummary'
	| 'getClosetItemProbeEmbed'
	| 'stampVectorIndexedAt'
	| 'stampVectorIndexedAtMany'
	| 'setClosetIndexStatus'
	| 'listUnindexedClosetItemIds'
	| 'listClaimedNewMatchesWithoutItem'
	| 'getMatchWithOutfit'
	| 'getMatchByResolvedClosetItemId'
	| 'getLatestWearImageForClosetItem'
>;

export type ClosetVectorRepairIdentity = Pick<CropEncoder, 'getVectorsByIds' | 'prepareClosetCrop'> & {
	upsertPreparedCrop(...args: Parameters<CropEncoder['upsertPreparedCrop']>): Promise<unknown>;
};

export function isClosetVectorRepairJob(job: unknown): job is ClosetVectorRepairJob {
	if (typeof job !== 'object' || job === null) return false;
	const row = job as { kind?: unknown; closetItemId?: unknown };
	return row.kind === 'closet_vector_repair' && typeof row.closetItemId === 'string';
}

export function isClosetVectorBackfillJob(job: unknown): job is ClosetVectorBackfillJob {
	if (typeof job !== 'object' || job === null) return false;
	return (job as { kind?: unknown }).kind === 'closet_vector_backfill';
}

export function vectorRepairRetryDelaySeconds(attempts: number): number {
	const index = Math.max(0, attempts - 1);
	return VECTOR_REPAIR_RETRY_SECONDS[Math.min(index, VECTOR_REPAIR_RETRY_SECONDS.length - 1)] ?? 60;
}

export async function enqueueClosetVectorBackfillScan(
	queue: Pick<Queue, 'send'>,
	log: Logger
): Promise<boolean> {
	try {
		await queue.send({ kind: 'closet_vector_backfill', mode: 'scan' } satisfies ClosetVectorBackfillJob);
		log.info('closet_vector_backfill_scan_enqueued');
		return true;
	} catch (err) {
		log.warn('closet_vector_backfill_scan_enqueue_failed', {}, err);
		return false;
	}
}

export async function runClosetVectorRepair(params: {
	job: ClosetVectorRepairJob | ClosetVectorBackfillJob;
	closet: ClosetVectorRepairStore;
	identity: ClosetVectorRepairIdentity;
	log: Logger;
	attempts?: number;
	queue?: Pick<Queue, 'send'>;
	resumeClaimedNew?: (match: ClosetItemMatchWithOutfit) => Promise<unknown>;
}): Promise<ClosetVectorRepairDecision> {
	if (isClosetVectorBackfillJob(params.job) && params.job.mode === 'scan') {
		return runClosetVectorBackfillScan(params);
	}

	const closetItemId =
		(isClosetVectorRepairJob(params.job) ? params.job.closetItemId : params.job.closetItemId)?.trim() ?? '';
	if (!closetItemId) {
		params.log.warn('closet_vector_repair_invalid_job');
		return { action: 'ack', reason: 'invalid' };
	}

	const item = await params.closet.getClosetItemSummary(closetItemId);
	if (!item) {
		params.log.info('closet_vector_repair_missing_item', {
			closet_item_id: closetItemId,
			kind: isClosetVectorRepairJob(params.job) ? params.job.kind : params.job.kind,
		});
		return { action: 'ack', reason: 'missing_item' };
	}
	if (item.vector_indexed_at != null) {
		return { action: 'ack', reason: 'already_stamped' };
	}

	await params.closet.setClosetIndexStatus(closetItemId, 'indexing', {
		incrementAttempts: true,
	});

	const vectorId = closetItemVectorId(closetItemId);
	const found = await params.identity.getVectorsByIds([vectorId]);
	if (found.length > 0) {
		await params.closet.stampVectorIndexedAt(closetItemId);
		params.log.info('closet_vector_repair_stamped', { closet_item_id: closetItemId, vector_id: vectorId });
		return { action: 'ack', reason: 'stamped' };
	}

	const match = await loadRepairMatch(params.closet, params.job, closetItemId);
	try {
		const prepared = await preparedForRepair(params.identity, params.closet, closetItemId, match);
		await params.identity.upsertPreparedCrop(prepared, {
			userId: item.user_id,
			category: item.category,
			closetItemId,
		});
		params.log.info('closet_vector_repair_reupserted', { closet_item_id: closetItemId, vector_id: vectorId });
	} catch (err) {
		params.log.warn('closet_vector_repair_reupsert_failed', { closet_item_id: closetItemId }, err);
	}

	const attempts = params.attempts ?? 1;
	if (attempts >= VECTOR_REPAIR_MAX_ATTEMPTS) {
		await params.closet.setClosetIndexStatus(closetItemId, 'index_degraded');
		params.log.warn('closet_vector_repair_exhausted', {
			closet_item_id: closetItemId,
			attempts,
		});
		if (isClosetVectorRepairJob(params.job) && params.queue) {
			try {
				await params.queue.send(
					{ kind: 'closet_vector_backfill', closetItemId } satisfies ClosetVectorBackfillJob,
					{ delaySeconds: VECTOR_REPAIR_BACKFILL_DELAY_SECONDS }
				);
			} catch (err) {
				params.log.warn('closet_vector_backfill_enqueue_failed', { closet_item_id: closetItemId }, err);
			}
		}
		return { action: 'ack', reason: 'exhausted' };
	}

	return { action: 'retry', delaySeconds: vectorRepairRetryDelaySeconds(attempts) };
}

async function runClosetVectorBackfillScan(params: {
	closet: ClosetVectorRepairStore;
	identity: ClosetVectorRepairIdentity;
	log: Logger;
	queue?: Pick<Queue, 'send'>;
	resumeClaimedNew?: (match: ClosetItemMatchWithOutfit) => Promise<unknown>;
}): Promise<ClosetVectorRepairDecision> {
	const itemIds = await params.closet.listUnindexedClosetItemIds(VECTOR_BACKFILL_SCAN_LIMIT);
	let stamped = 0;
	let enqueued = 0;
	for (const chunk of chunkIds(itemIds, VECTOR_BACKFILL_GET_BY_IDS_CHUNK)) {
		const vectorIds = chunk.map((id) => closetItemVectorId(id));
		const found = vectorIds.length === 0 ? [] : await params.identity.getVectorsByIds(vectorIds);
		const visible = new Set(found.map((row) => row.id));
		const hits = chunk.filter((id) => visible.has(closetItemVectorId(id)));
		const misses = chunk.filter((id) => !visible.has(closetItemVectorId(id)));
		if (hits.length > 0) {
			stamped += await params.closet.stampVectorIndexedAtMany(hits);
		}
		if (params.queue) {
			for (const closetItemId of misses) {
				try {
					await params.queue.send({ kind: 'closet_vector_backfill', closetItemId } satisfies ClosetVectorBackfillJob);
					enqueued += 1;
				} catch (err) {
					params.log.warn('closet_vector_backfill_enqueue_failed', { closet_item_id: closetItemId }, err);
				}
			}
		}
	}

	const orphans = await params.closet.listClaimedNewMatchesWithoutItem(VECTOR_BACKFILL_ORPHAN_MATCH_LIMIT);
	let resumed = 0;
	for (const match of orphans) {
		if (!params.resumeClaimedNew) break;
		try {
			await params.resumeClaimedNew(match);
			resumed += 1;
		} catch (err) {
			params.log.warn(
				'closet_vector_backfill_orphan_resume_failed',
				{ match_id: match.id, closet_item_id: match.resolved_closet_item_id },
				err
			);
		}
	}

	params.log.info('closet_vector_backfill_scanned', {
		unindexed: itemIds.length,
		stamped,
		enqueued,
		orphans: orphans.length,
		resumed,
	});
	return { action: 'ack', reason: 'scanned' };
}

function chunkIds(ids: string[], size: number): string[][] {
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += size) {
		chunks.push(ids.slice(i, i + size));
	}
	return chunks;
}

async function loadRepairMatch(
	closet: ClosetVectorRepairStore,
	job: ClosetVectorRepairJob | ClosetVectorBackfillJob,
	closetItemId: string
): Promise<ClosetItemMatchWithOutfit | null> {
	if (isClosetVectorRepairJob(job) && job.matchId.trim() && job.userId.trim()) {
		const match = await closet.getMatchWithOutfit(job.userId, job.matchId);
		if (match) return match;
	}
	return closet.getMatchByResolvedClosetItemId(closetItemId);
}

async function preparedForRepair(
	identity: ClosetVectorRepairIdentity,
	closet: ClosetVectorRepairStore,
	closetItemId: string,
	match: ClosetItemMatchWithOutfit | null
): Promise<PreparedClosetCrop> {
	const itemProbe = await closet.getClosetItemProbeEmbed(closetItemId);
	const fromItem = preparedFromProbeEmbed(itemProbe, match?.outfit_image_key ?? '');
	if (fromItem) return fromItem;
	const fromProbe = match ? preparedFromProbeEmbed(match.probe_embed, match.outfit_image_key) : null;
	if (fromProbe) return fromProbe;
	if (match) {
		return identity.prepareClosetCrop({
			imageKey: match.outfit_image_key,
			boundingBox: match.bounding_box,
		});
	}
	const wear = await closet.getLatestWearImageForClosetItem(closetItemId);
	if (!wear) {
		throw new Error(`No probe or wear to re-upsert closet item ${closetItemId}`);
	}
	return identity.prepareClosetCrop({
		imageKey: wear.imageKey,
		boundingBox: wear.boundingBox,
	});
}
