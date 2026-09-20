import { describe, expect, it } from 'vitest';
import type { ClosetIndexStatus, ClosetItemMatchWithOutfit } from '../src/db/closet';
import {
	VECTOR_REPAIR_MAX_ATTEMPTS,
	enqueueClosetVectorBackfillScan,
	isClosetVectorBackfillJob,
	isClosetVectorRepairJob,
	runClosetVectorRepair,
	vectorRepairRetryDelaySeconds,
	type ClosetVectorRepairJob,
} from '../src/services/identity/jobs/closetVectorRepair';
import { closetMatchProbeFromPrepared } from '../src/services/identity/encode/probeEmbed';
import { closetItemVectorId } from '../src/services/identity/encode/vectorize.store';
import type { PreparedClosetCrop } from '../src/services/identity/encode/cropEncoder';
import type { Logger } from '../src/utils/logger.utils';

const PREPARED: PreparedClosetCrop = {
	model: 'dino',
	dimensions: 1024,
	index_dimensions: 1024,
	matches_index: true,
	vector_preview: [],
	crop_image_key: 'crop.jpg',
	crop_image_url: 'https://crop',
	crop_width: 100,
	crop_height: 100,
	source_image_key: 'users/u1/test.jpg',
	crop_color: null,
	crop_blur_hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
	vector: Array(1024).fill(0.1),
};

const JOB: ClosetVectorRepairJob = {
	kind: 'closet_vector_repair',
	closetItemId: 'new-1',
	matchId: 'match-1',
	userId: 'u1',
};

describe('closet vector repair jobs', () => {
	it('recognizes repair and backfill kinds', () => {
		expect(isClosetVectorRepairJob(JOB)).toBe(true);
		expect(isClosetVectorRepairJob({ kind: 'closet_identity' })).toBe(false);
		expect(isClosetVectorBackfillJob({ kind: 'closet_vector_backfill', closetItemId: 'new-1' })).toBe(
			true
		);
		expect(isClosetVectorBackfillJob({ kind: 'closet_vector_repair' })).toBe(false);
	});

	it('uses 2s then 5s then 15s retry delays', () => {
		expect(vectorRepairRetryDelaySeconds(1)).toBe(2);
		expect(vectorRepairRetryDelaySeconds(2)).toBe(5);
		expect(vectorRepairRetryDelaySeconds(3)).toBe(15);
	});
});

describe('runClosetVectorRepair', () => {
	it('stamps vector_indexed_at on a getByIds hit and does not upsert or delete', async () => {
		const harness = createRepairHarness({ visibleIds: [closetItemVectorId('new-1')] });

		const decision = await runClosetVectorRepair({
			job: JOB,
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
		});

		expect(decision).toEqual({ action: 'ack', reason: 'stamped' });
		expect(harness.closet.stamps).toEqual(['new-1']);
		expect(harness.closet.statusUpdates).toEqual([
			{ itemId: 'new-1', status: 'indexing', incrementAttempts: true },
		]);
		expect(harness.closet.item.index_status).toBe('indexed');
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.identity.getByIdsCalls).toEqual([[closetItemVectorId('new-1')]]);
	});

	it('re-upserts from the stored probe on a miss and retries', async () => {
		const harness = createRepairHarness({ visibleIds: [] });

		const decision = await runClosetVectorRepair({
			job: JOB,
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
			attempts: 1,
		});

		expect(decision).toEqual({ action: 'retry', delaySeconds: 2 });
		expect(harness.closet.stamps).toEqual([]);
		expect(harness.closet.item.index_status).toBe('indexing');
		expect(harness.identity.upserts).toEqual([{ closetItemId: 'new-1' }]);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.identity.deletes).toHaveLength(0);
	});

	it('re-embeds from the cover crop when the stored probe encoder is stale', async () => {
		const harness = createRepairHarness({ visibleIds: [], staleProbe: true });

		const decision = await runClosetVectorRepair({
			job: JOB,
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
			attempts: 1,
		});

		expect(decision).toEqual({ action: 'retry', delaySeconds: 2 });
		expect(harness.identity.prepares).toBe(1);
		expect(harness.identity.upserts).toEqual([{ closetItemId: 'new-1' }]);
		expect(harness.identity.deletes).toHaveLength(0);
	});

	it('acks already-stamped items without touching Vectorize', async () => {
		const harness = createRepairHarness({ visibleIds: [] });
		harness.closet.item.vector_indexed_at = Date.now();

		const decision = await runClosetVectorRepair({
			job: JOB,
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
		});

		expect(decision).toEqual({ action: 'ack', reason: 'already_stamped' });
		expect(harness.identity.getByIdsCalls).toEqual([]);
		expect(harness.identity.upserts).toHaveLength(0);
	});

	it('enqueues backfill after max attempts and never deletes the vector', async () => {
		const harness = createRepairHarness({ visibleIds: [] });
		const sent: unknown[] = [];

		const decision = await runClosetVectorRepair({
			job: JOB,
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
			attempts: VECTOR_REPAIR_MAX_ATTEMPTS,
			queue: {
				send: async (job, options) => {
					sent.push({ job, options });
				},
			},
		});

		expect(decision).toEqual({ action: 'ack', reason: 'exhausted' });
		expect(harness.closet.item.index_status).toBe('index_degraded');
		expect(harness.identity.deletes).toHaveLength(0);
		expect(sent).toEqual([
			{
				job: { kind: 'closet_vector_backfill', closetItemId: 'new-1' },
				options: { delaySeconds: 60 },
			},
		]);
	});

	it('stamps getByIds hits on scan and enqueues misses without embedding', async () => {
		const harness = createRepairHarness({
			visibleIds: [closetItemVectorId('hit-1'), closetItemVectorId('hit-2')],
		});
		harness.closet.unindexedIds = ['hit-1', 'miss-1', 'hit-2'];
		const sent: unknown[] = [];

		const decision = await runClosetVectorRepair({
			job: { kind: 'closet_vector_backfill', mode: 'scan' },
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
			queue: {
				send: async (job) => {
					sent.push(job);
				},
			},
		});

		expect(decision).toEqual({ action: 'ack', reason: 'scanned' });
		expect(harness.closet.batchStamps).toEqual([['hit-1', 'hit-2']]);
		expect(sent).toEqual([{ kind: 'closet_vector_backfill', closetItemId: 'miss-1' }]);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(0);
	});

	it('resumes claimed new matches that have no closet row', async () => {
		const harness = createRepairHarness({ visibleIds: [] });
		const orphan = {
			id: 'match-orphan',
			user_id: 'u1',
			resolved_closet_item_id: 'reserved-1',
		};
		harness.closet.orphans = [orphan as never];
		const resumed: string[] = [];

		const decision = await runClosetVectorRepair({
			job: { kind: 'closet_vector_backfill', mode: 'scan' },
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
			resumeClaimedNew: async (match) => {
				resumed.push(match.id);
			},
		});

		expect(decision).toEqual({ action: 'ack', reason: 'scanned' });
		expect(resumed).toEqual(['match-orphan']);
		expect(harness.identity.prepares).toBe(0);
	});
});

describe('enqueueClosetVectorBackfillScan', () => {
	it('sends a scan job and swallows send failures', async () => {
		const sent: unknown[] = [];
		expect(
			await enqueueClosetVectorBackfillScan(
				{
					send: async (job) => {
						sent.push(job);
					},
				},
				silentLogger()
			)
		).toBe(true);
		expect(sent).toEqual([{ kind: 'closet_vector_backfill', mode: 'scan' }]);

		expect(
			await enqueueClosetVectorBackfillScan(
				{
					send: async () => {
						throw new Error('queue down');
					},
				},
				silentLogger()
			)
		).toBe(false);
	});
});

function createRepairHarness(options: { visibleIds: string[]; staleProbe?: boolean }) {
	const match: ClosetItemMatchWithOutfit = {
		id: 'match-1',
		user_id: 'u1',
		outfit_id: 'outfit-1',
		candidate_closet_item_id: 'c1',
		bounding_box: { x: 20, y: 15, width: 40, height: 35 },
		confidence: 'high',
		extract_snapshot: {
			label: 'olive shirt',
			category: 'top',
			subcategory: 'shirt',
			color: 'olive',
			pattern: 'solid',
			styleTags: [],
		},
		score: 0.77,
		cosine: 0.96,
		color_distance: 0.03,
		band: 'ask',
		status: 'new',
		created_at: Date.now(),
		resolved_at: Date.now(),
		resolved_closet_item_id: 'new-1',
		probe_embed: options.staleProbe
			? {
					encoder: 'jina-clip-v2',
					dimensions: PREPARED.dimensions,
					vector: PREPARED.vector,
					crop_color: PREPARED.crop_color,
					crop_blur_hash: PREPARED.crop_blur_hash,
				}
			: closetMatchProbeFromPrepared(PREPARED),
		outfit_image_key: 'users/u1/test.jpg',
		outfit_original_image_url: 'https://img/test.jpg',
	};
	const closet = {
		item: {
			id: 'new-1',
			user_id: 'u1',
			label: 'olive shirt',
			category: 'top',
			vector_indexed_at: null as number | null,
			index_status: 'committed',
			index_attempts: 0,
		} as {
			id: string;
			user_id: string;
			label: string;
			category: string;
			vector_indexed_at: number | null;
			index_status: ClosetIndexStatus;
			index_attempts: number;
		},
		stamps: [] as string[],
		batchStamps: [] as string[][],
		statusUpdates: [] as Array<{ itemId: string; status: string; incrementAttempts?: boolean }>,
		unindexedIds: [] as string[],
		orphans: [] as ClosetItemMatchWithOutfit[],
		async getClosetItemSummary(itemId: string) {
			return itemId === this.item.id ? this.item : null;
		},
		async setClosetIndexStatus(
			itemId: string,
			status: 'committed' | 'indexing' | 'index_degraded',
			params?: { incrementAttempts?: boolean }
		) {
			this.statusUpdates.push({ itemId, status, incrementAttempts: params?.incrementAttempts });
			if (itemId !== this.item.id || this.item.vector_indexed_at != null) return false;
			this.item.index_status = status;
			if (params?.incrementAttempts) {
				this.item.index_attempts += 1;
			}
			return true;
		},
		async stampVectorIndexedAt(itemId: string) {
			this.stamps.push(itemId);
			this.item.vector_indexed_at = Date.now();
			this.item.index_status = 'indexed';
			return true;
		},
		async stampVectorIndexedAtMany(itemIds: readonly string[]) {
			this.batchStamps.push([...itemIds]);
			return itemIds.length;
		},
		async listUnindexedClosetItemIds() {
			return this.unindexedIds;
		},
		async listClaimedNewMatchesWithoutItem() {
			return this.orphans;
		},
		async getMatchWithOutfit() {
			return match;
		},
		async getMatchByResolvedClosetItemId() {
			return match;
		},
		async getClosetItemProbeEmbed() {
			return null;
		},
		async getLatestWearImageForClosetItem() {
			return null;
		},
	};
	const identity = {
		prepares: 0,
		upserts: [] as Array<{ closetItemId?: string }>,
		deletes: [] as string[],
		getByIdsCalls: [] as string[][],
		async getVectorsByIds(ids: string[]) {
			this.getByIdsCalls.push(ids);
			return options.visibleIds.filter((id) => ids.includes(id)).map((id) => ({ id }));
		},
		async upsertPreparedCrop(_prepared: PreparedClosetCrop, params: { closetItemId?: string }) {
			this.upserts.push({ closetItemId: params.closetItemId });
		},
		async prepareClosetCrop() {
			this.prepares += 1;
			return PREPARED;
		},
		async deleteVector(vectorId: string) {
			this.deletes.push(vectorId);
		},
	};
	return { closet, identity };
}

function silentLogger(): Logger {
	const log: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return log;
		},
	};
	return log;
}
