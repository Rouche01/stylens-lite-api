import { describe, expect, it } from 'vitest';
import type { ClosetItemMatchWithOutfit } from '../src/db/closet';
import {
	VECTOR_REPAIR_MAX_ATTEMPTS,
	isClosetVectorBackfillJob,
	isClosetVectorRepairJob,
	runClosetVectorRepair,
	vectorRepairRetryDelaySeconds,
	type ClosetVectorRepairJob,
} from '../src/services/identity/closetVectorRepair';
import { closetMatchProbeFromPrepared } from '../src/services/identity/probeEmbed';
import { closetItemVectorId } from '../src/services/identity/vectorize.store';
import type { PreparedClosetCrop } from '../src/services/identity';
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
		expect(harness.identity.upserts).toEqual([{ closetItemId: 'new-1' }]);
		expect(harness.identity.prepares).toBe(0);
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
		expect(harness.identity.deletes).toHaveLength(0);
		expect(sent).toEqual([
			{
				job: { kind: 'closet_vector_backfill', closetItemId: 'new-1' },
				options: { delaySeconds: 60 },
			},
		]);
	});

	it('skips scan-mode backfill until the hourly sweep exists', async () => {
		const harness = createRepairHarness({ visibleIds: [] });

		const decision = await runClosetVectorRepair({
			job: { kind: 'closet_vector_backfill', mode: 'scan' },
			closet: harness.closet,
			identity: harness.identity,
			log: silentLogger(),
		});

		expect(decision).toEqual({ action: 'ack', reason: 'scan_skipped' });
		expect(harness.identity.getByIdsCalls).toEqual([]);
	});
});

function createRepairHarness(options: { visibleIds: string[] }) {
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
		probe_embed: closetMatchProbeFromPrepared(PREPARED),
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
		},
		stamps: [] as string[],
		async getClosetItemSummary(itemId: string) {
			return itemId === this.item.id ? this.item : null;
		},
		async stampVectorIndexedAt(itemId: string) {
			this.stamps.push(itemId);
			this.item.vector_indexed_at = Date.now();
			return true;
		},
		async getMatchWithOutfit() {
			return match;
		},
		async getMatchByResolvedClosetItemId() {
			return match;
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
