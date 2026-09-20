import { describe, expect, it } from 'vitest';
import {
	ClothingItem,
	ClothingItemCategory,
	ClothingItemPattern,
	ClothingItemSubcategory,
	ExtractionConfidence,
	OutfitExtractionResponse,
} from '../src/types';
import {
	ClosetMatchNotFoundError,
	ClosetMatchResolvedError,
	IdentityBusyError,
	OutfitIdentityProcessor,
	candidateClosetItemId,
	closetMatchProbeFromPrepared,
	decideCommitAfterRequery,
	decideIdentityFromNeighbors,
	shouldQueryIdentity,
} from '../src/services/identity/processOutfitImage';
import type { PreparedClosetCrop, QueryClosetCropMatch } from '../src/services/identity';
import type { ClosetItem, ClosetItemMatch, ClosetItemMatchWithOutfit, Outfit } from '../src/db/closet';
import type { Logger } from '../src/utils/logger.utils';

const BOX = { x: 20, y: 15, width: 40, height: 35 };

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

describe('decideIdentityFromNeighbors', () => {
	it('creates when the closet is empty', () => {
		expect(decideIdentityFromNeighbors([])).toEqual({ action: 'create', reason: 'no_neighbor' });
	});

	it('creates below the 0.50 ask floor', () => {
		expect(decideIdentityFromNeighbors([neighbor({ identity_score: 0.24 })])).toEqual({
			action: 'create',
			reason: 'below_threshold',
			identityScore: 0.24,
		});
	});

	it('asks at or above 0.50 when a D1 candidate exists', () => {
		expect(decideIdentityFromNeighbors([neighbor({ identity_score: 0.77 })])).toEqual({
			action: 'ask',
			candidateClosetItemId: 'c1',
			identityScore: 0.77,
			cosine: 0.96,
			colorDistance: 0.03,
		});
	});

	it('creates when the neighbor is a scratch vector with no D1 row', () => {
		expect(
			decideIdentityFromNeighbors([
				neighbor({
					id: 'scratch:abc',
					closet_item_id: 'scratch:abc',
					d1_closet_item_id: null,
					identity_score: 0.8,
				}),
			])
		).toEqual({ action: 'create', reason: 'missing_candidate', identityScore: 0.8 });
	});
});

describe('decideCommitAfterRequery', () => {
	it('commits when no other neighbor matches', () => {
		expect(decideCommitAfterRequery('self-1', [])).toEqual({ action: 'commit' });
		expect(
			decideCommitAfterRequery('self-1', [
				neighbor({ id: 'item:self-1', closet_item_id: 'self-1', identity_score: 0.99 }),
			])
		).toEqual({ action: 'commit' });
	});

	it('asks when a committed D1 neighbor now matches', () => {
		expect(
			decideCommitAfterRequery('self-1', [
				neighbor({ identity_score: 0.77, d1_closet_item_id: 'c1', closet_item_id: 'c1' }),
			])
		).toEqual({
			action: 'ask',
			candidateClosetItemId: 'c1',
			identityScore: 0.77,
			cosine: 0.96,
			colorDistance: 0.03,
		});
	});

	it('yields when an uncommitted rival has a smaller id', () => {
		expect(
			decideCommitAfterRequery('z-self', [
				neighbor({
					id: 'item:a-winner',
					closet_item_id: 'a-winner',
					d1_closet_item_id: null,
					identity_score: 0.8,
				}),
			])
		).toEqual({
			action: 'yield',
			winnerId: 'a-winner',
			identityScore: 0.8,
			cosine: 0.96,
			colorDistance: 0.03,
		});
	});

	it('commits when this id is smaller than uncommitted rivals', () => {
		expect(
			decideCommitAfterRequery('a-self', [
				neighbor({
					id: 'item:z-rival',
					closet_item_id: 'z-rival',
					d1_closet_item_id: null,
					identity_score: 0.8,
				}),
			])
		).toEqual({ action: 'commit' });
	});

	it('commits when the only matching neighbor was rejected as new', () => {
		expect(
			decideCommitAfterRequery(
				'self-1',
				[neighbor({ identity_score: 0.77, d1_closet_item_id: 'c1', closet_item_id: 'c1' })],
				['c1']
			)
		).toEqual({ action: 'commit' });
	});
});

describe('candidateClosetItemId', () => {
	it('prefers D1 over vector metadata', () => {
		expect(
			candidateClosetItemId(neighbor({ d1_closet_item_id: 'd1-id', closet_item_id: 'meta-id' }))
		).toBe('d1-id');
	});
});

describe('shouldQueryIdentity', () => {
	it('skips low-confidence and tiny boxes', () => {
		expect(shouldQueryIdentity(clothingItem({ confidence: ExtractionConfidence.LOW }))).toBe(false);
		expect(shouldQueryIdentity(clothingItem({ bounding_box: { x: 0, y: 0, width: 1, height: 1 } }))).toBe(
			false
		);
		expect(shouldQueryIdentity(clothingItem())).toBe(true);
	});
});

describe('OutfitIdentityProcessor', () => {
	it('creates a closet tile and upserts when there is no neighbor', async () => {
		const harness = createHarness({ neighbors: [] });
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items).toHaveLength(1);
		expect(result?.items[0].identity_status).toBe('created');
		expect(result?.items[0].is_new_closet_item).toBe(true);
		expect(result?.items[0].closet_item_id).toBeTruthy();
		expect(harness.closet.items).toHaveLength(1);
		expect(harness.closet.links).toHaveLength(1);
		expect(harness.closet.links[0].blurHash).toBe('LEHV6nWB2yk8pyo0adR*.7kCMdnj');
		expect(harness.closet.matches).toHaveLength(0);
		expect(harness.closet.items[0].index_status).toBe('indexing');
		expect(harness.identity.upserts).toHaveLength(1);
		expect(harness.identity.upserts[0].closetItemId).toBe(result?.items[0].closet_item_id);
		expect(harness.identity.prepares).toBe(1);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.digestSchedules).toEqual([]);
		expect(harness.catalogNotifies).toEqual([]);
		expect(harness.closet.outfits[0].image_width).toBe(1000);
		expect(harness.closet.outfits[0].image_height).toBe(1500);
	});

	it('backfills image dimensions on an existing outfit without size', async () => {
		const harness = createHarness({ neighbors: [] });
		harness.closet.outfits.push({
			id: 'outfit-existing',
			user_id: 'u1',
			original_image_url: 'https://img/test.jpg',
			image_key: 'users/u1/test.jpg',
			created_at: Date.now(),
			image_width: null,
			image_height: null,
		});
		await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(harness.closet.outfits).toHaveLength(1);
		expect(harness.closet.outfits[0].id).toBe('outfit-existing');
		expect(harness.closet.outfits[0].image_width).toBe(1000);
		expect(harness.closet.outfits[0].image_height).toBe(1500);
	});

	it('creates when identity_score is 0.24', async () => {
		const harness = createHarness({
			neighbors: [neighbor({ identity_score: 0.24, score: 0.96, color_distance: 0.13 })],
		});
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_status).toBe('created');
		expect(result?.items[0].identity_reason).toBe('below_threshold');
		expect(result?.items[0].identity_score).toBe(0.24);
		expect(harness.closet.matches).toHaveLength(0);
		expect(harness.closet.items).toHaveLength(1);
	});

	it('asks and does not create a closet tile when identity_score is 0.77', async () => {
		const harness = createHarness({
			neighbors: [neighbor({ identity_score: 0.77 })],
		});
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0]).toMatchObject({
			identity_status: 'ask',
			is_new_closet_item: false,
			closet_item_id: null,
			candidate_closet_item_id: 'c1',
			identity_score: 0.77,
		});
		expect(result?.items[0].match_id).toBeTruthy();
		expect(harness.closet.items).toHaveLength(0);
		expect(harness.closet.links).toHaveLength(0);
		expect(harness.closet.matches).toHaveLength(1);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.digestSchedules).toEqual(['u1']);
		expect(harness.closet.askTouches).toEqual(['u1']);
		expect(harness.closet.matches[0].probe_embed).toEqual({
			encoder: 'dinov3-cls-v1',
			dimensions: PREPARED.dimensions,
			vector: PREPARED.vector,
			crop_color: PREPARED.crop_color,
			crop_blur_hash: PREPARED.crop_blur_hash,
		});
		expect(harness.closet.matches[0].probe_embed?.encoder).not.toBe(PREPARED.model);
	});

	it('enqueues one digest when several crops ask in the same process', async () => {
		const harness = createHarness({
			items: [clothingItem(), clothingItem({ label: 'navy pants', category: ClothingItemCategory.BOTTOM })],
			neighbors: [neighbor({ identity_score: 0.77 })],
			requeryNeighbors: [neighbor({ identity_score: 0.77 })],
		});
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items.every((item) => item.identity_status === 'ask')).toBe(true);
		expect(harness.closet.matches).toHaveLength(2);
		expect(harness.digestSchedules).toEqual(['u1']);
	});

	it('creates when identity query throws but upsert succeeds', async () => {
		const harness = createHarness({ queryError: new Error('vectorize query down') });
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_reason).toBe('identity_error');
		expect(harness.closet.items).toHaveLength(1);
		expect(harness.identity.prepares).toBe(1);
		expect(harness.closet.matches).toHaveLength(0);
	});

	it('creates a closet tile even when vector upsert fails (index retries later)', async () => {
		const harness = createHarness({
			neighbors: [],
			upsertError: new Error('vectorize down'),
		});
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0]).toMatchObject({
			identity_status: 'created',
			is_new_closet_item: true,
		});
		expect(result?.items[0].closet_item_id).toBeTruthy();
		expect(harness.closet.items).toHaveLength(1);
		expect(harness.closet.links).toHaveLength(1);
		expect(harness.identity.upserts).toHaveLength(1);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.repairSends).toEqual([
			{ kind: 'closet_vector_backfill', closetItemId: result?.items[0].closet_item_id },
		]);
	});

	it('does not wait on Vectorize visibility before committing D1', async () => {
		const harness = createHarness({ neighbors: [], visible: false });
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_status).toBe('created');
		expect(harness.closet.items).toHaveLength(1);
		expect(harness.identity.waits).toBe(0);
		expect(harness.identity.deletes).toHaveLength(0);
	});

	it('does not requery after upsert on silent create', async () => {
		const harness = createHarness({
			neighbors: [],
			requeryNeighbors: [neighbor({ identity_score: 0.77 })],
		});
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_status).toBe('created');
		expect(harness.closet.items).toHaveLength(1);
		expect(harness.closet.matches).toHaveLength(0);
		expect(harness.identity.queries).toBe(1);
		expect(harness.identity.deletes).toHaveLength(0);
	});

	it('does not create a closet tile when D1 insert fails', async () => {
		const harness = createHarness({ neighbors: [], d1Error: new Error('d1 down') });
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_reason).toBe('d1_failed');
		expect(harness.closet.items).toHaveLength(0);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(0);
	});
});

describe('OutfitIdentityProcessor.resolveMatch', () => {
	it('links the wear to the candidate on same and does not upsert', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'same',
		});

		expect(result).toMatchObject({
			decision: 'same',
			match_id: match.id,
			closet_item_id: 'c1',
			identity_reason: 'same',
		});
		expect(harness.closet.links).toEqual([
			{ outfitId: 'outfit-1', closetItemId: 'c1', blurHash: null, boundingBox: BOX },
		]);
		expect(harness.closet.items.map((item) => item.id)).toEqual(['c1']);
		expect(harness.closet.matches[0].status).toBe('same');
		expect(harness.closet.lock).toBeNull();
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.repairSends).toEqual([]);
		expect(harness.catalogNotifies).toEqual([
			{
				userId: 'u1',
				outfitId: 'outfit-1',
				items: [{ closet_item_id: 'c1', identity_status: 'created' }],
			},
		]);
	});

	it('creates a new tile on user-confirmed new even if a neighbor still matches', async () => {
		const harness = createHarness({
			neighbors: [neighbor({ identity_score: 0.77 })],
			requeryNeighbors: [neighbor({ identity_score: 0.77 })],
		});
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.decision).toBe('new');
		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBeTruthy();
		expect(result.closet_item_id).not.toBe('c1');
		expect(harness.closet.matches[0].status).toBe('new');
		expect(harness.closet.matches[0].resolved_closet_item_id).toBe(result.closet_item_id);
		expect(harness.closet.items).toHaveLength(2);
		expect(harness.closet.links).toEqual([
			{
				outfitId: 'outfit-1',
				closetItemId: result.closet_item_id,
				blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
				boundingBox: BOX,
			},
		]);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.identity.queries).toBe(0);
		expect(harness.identity.waits).toBe(0);
		expect(harness.closet.lock).toBeNull();
		expect(harness.catalogNotifies).toHaveLength(1);
		expect(harness.catalogNotifies[0]).toMatchObject({
			userId: 'u1',
			outfitId: 'outfit-1',
			items: [{ closet_item_id: result.closet_item_id, identity_status: 'created' }],
		});
		expect(harness.repairSends).toEqual([
			{
				kind: 'closet_vector_repair',
				closetItemId: result.closet_item_id,
				matchId: match.id,
				userId: 'u1',
			},
		]);
	});

	it('does not retarget to ask on user-confirmed new', async () => {
		const harness = createHarness({
			neighbors: [
				neighbor({
					id: 'item:c2',
					closet_item_id: 'c2',
					d1_closet_item_id: 'c2',
					identity_score: 0.81,
				}),
			],
		});
		harness.closet.items.push({
			id: 'c2',
			user_id: 'u1',
			label: 'navy shirt',
			category: 'top',
			subcategory: 'shirt',
			color: 'navy',
			pattern: 'solid',
			style_tags: [],
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.decision).toBe('new');
		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBeTruthy();
		expect(harness.closet.matches[0].status).toBe('new');
		expect(harness.identity.prepares).toBe(0);
		expect(harness.identity.queries).toBe(0);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.digestSchedules).toEqual([]);
		expect(harness.catalogNotifies).toHaveLength(1);
	});

	it('falls back to prepareClosetCrop when probe_embed is missing', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		harness.closet.matches[0].probe_embed = null;

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBeTruthy();
		expect(harness.identity.prepares).toBe(1);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.closet.matches[0].status).toBe('new');
	});

	it('falls back to prepareClosetCrop when the stored encoder is stale', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		const probe = closetMatchProbeFromPrepared(PREPARED);
		harness.closet.matches[0].probe_embed = probe ? { ...probe, encoder: 'jina-clip-v2' } : null;

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('created');
		expect(harness.identity.prepares).toBe(1);
		expect(harness.identity.upserts).toHaveLength(0);
	});

	it('leaves the match pending when fallback embed throws', async () => {
		const harness = createHarness({ prepareError: new Error('replicate down') });
		const match = seedPendingMatch(harness.closet);
		harness.closet.matches[0].probe_embed = null;

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('failed');
		expect(result.identity_reason).toBe('embed_failed');
		expect(harness.identity.prepares).toBe(1);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.closet.matches[0].status).toBe('pending');
		expect(harness.closet.items.map((item) => item.id)).toEqual(['c1']);
		expect(harness.repairSends).toEqual([]);
	});

	it('enqueues index onto the writer queue without Vectorize on resolve-new', async () => {
		const harness = createHarness({ upsertError: new Error('vectorize down') });
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBeTruthy();
		expect(harness.identity.prepares).toBe(0);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.closet.matches[0].status).toBe('new');
		expect(harness.closet.items.map((item) => item.id)).toEqual(['c1', result.closet_item_id]);
		expect(harness.closet.items.find((item) => item.id === result.closet_item_id)?.index_status).toBe(
			'indexing'
		);
		expect(harness.catalogNotifies).toHaveLength(1);
		expect(harness.closet.lock).toBeNull();
		expect(harness.repairSends).toEqual([
			{
				kind: 'closet_vector_repair',
				closetItemId: result.closet_item_id,
				matchId: match.id,
				userId: 'u1',
			},
		]);
	});

	it('returns 200 on retry once the tile already exists', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);

		const first = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});
		expect(first.identity_status).toBe('created');
		expect(harness.closet.matches[0].status).toBe('new');

		const retry = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(retry.identity_status).toBe('created');
		expect(retry.closet_item_id).toBe(first.closet_item_id);
		expect(harness.closet.items.filter((item) => item.id !== 'c1')).toHaveLength(1);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.closet.lock).toBeNull();
	});

	it('does not upsert when resolve-new loses the CAS', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		harness.closet.stealClaimAs = 'same';

		await expect(
			harness.processor.resolveMatch({ userId: 'u1', matchId: match.id, decision: 'new' })
		).rejects.toBeInstanceOf(ClosetMatchResolvedError);

		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.closet.items.map((item) => item.id)).toEqual(['c1']);
		expect(harness.closet.matches[0].status).toBe('same');
		expect(harness.repairSends).toEqual([]);
	});

	it('does not link a wear when resolve-same loses the CAS', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		harness.closet.stealClaimAs = 'new';

		await expect(
			harness.processor.resolveMatch({ userId: 'u1', matchId: match.id, decision: 'same' })
		).rejects.toBeInstanceOf(ClosetMatchResolvedError);

		expect(harness.closet.links).toHaveLength(0);
		expect(harness.closet.matches[0].status).toBe('new');
	});

	it('returns 200 when the same decision is posted again', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);

		await harness.processor.resolveMatch({ userId: 'u1', matchId: match.id, decision: 'same' });
		const again = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'same',
		});

		expect(again).toMatchObject({
			decision: 'same',
			match_id: match.id,
			closet_item_id: 'c1',
			identity_status: 'created',
		});
		expect(harness.closet.links).toHaveLength(1);
		expect(harness.closet.matches[0].status).toBe('same');
	});

	it('returns 200 with the same closet item when new is posted again', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);

		const first = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});
		const again = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(again.identity_status).toBe('created');
		expect(again.closet_item_id).toBe(first.closet_item_id);
		expect(harness.closet.items.filter((item) => item.id !== 'c1')).toHaveLength(1);
		expect(harness.closet.links).toHaveLength(1);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
	});

	it('still returns 200 when repair enqueue throws', async () => {
		const harness = createHarness({ neighbors: [], repairError: new Error('queue down') });
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBeTruthy();
		expect(harness.closet.matches[0].status).toBe('new');
		expect(harness.repairSends).toEqual([]);
	});

	it('finishes an incomplete new claim on the reserved closet item id', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		harness.closet.matches[0].status = 'new';
		harness.closet.matches[0].resolved_at = Date.now();
		harness.closet.matches[0].resolved_closet_item_id = 'reserved-1';
		harness.closet.matches[0].probe_embed = closetMatchProbeFromPrepared(PREPARED);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result).toMatchObject({
			decision: 'new',
			closet_item_id: 'reserved-1',
			identity_status: 'created',
		});
		expect(harness.closet.items.map((item) => item.id)).toEqual(['c1', 'reserved-1']);
		expect(harness.closet.links).toEqual([
			{
				outfitId: 'outfit-1',
				closetItemId: 'reserved-1',
				blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
				boundingBox: BOX,
			},
		]);
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.closet.matches[0].status).toBe('new');
		expect(harness.repairSends).toEqual([
			{
				kind: 'closet_vector_repair',
				closetItemId: 'reserved-1',
				matchId: match.id,
				userId: 'u1',
			},
		]);
	});

	it('returns 200 for the CAS-losing new tap when the winner was also new', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		harness.closet.items.push({
			id: 'winner-1',
			user_id: 'u1',
			label: 'olive shirt',
			category: 'top',
			subcategory: 'shirt',
			color: 'olive',
			pattern: 'solid',
			style_tags: [],
			created_at: Date.now(),
			updated_at: Date.now(),
		});
		harness.closet.stealClaimAs = 'new';
		harness.closet.stealResolvedClosetItemId = 'winner-1';

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBe('winner-1');
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(0);
		expect(harness.identity.prepares).toBe(0);
		expect(harness.closet.items.map((item) => item.id)).toEqual(['c1', 'winner-1']);
		expect(harness.closet.links).toEqual([
			{
				outfitId: 'outfit-1',
				closetItemId: 'winner-1',
				blurHash: null,
				boundingBox: BOX,
			},
		]);
		expect(harness.repairSends).toEqual([
			{
				kind: 'closet_vector_repair',
				closetItemId: 'winner-1',
				matchId: match.id,
				userId: 'u1',
			},
		]);
	});

	it('rejects the opposite decision after the match is resolved', async () => {
		const harness = createHarness({ neighbors: [] });
		const match = seedPendingMatch(harness.closet);
		harness.closet.matches[0].status = 'same';
		harness.closet.matches[0].resolved_closet_item_id = 'c1';

		await expect(
			harness.processor.resolveMatch({ userId: 'u1', matchId: match.id, decision: 'new' })
		).rejects.toBeInstanceOf(ClosetMatchResolvedError);
	});

	it('rejects an unknown match', async () => {
		const harness = createHarness({ neighbors: [] });
		await expect(
			harness.processor.resolveMatch({ userId: 'u1', matchId: 'missing', decision: 'same' })
		).rejects.toBeInstanceOf(ClosetMatchNotFoundError);
	});
});

describe('serial identity writer', () => {
	it('holds identity_inflight for outfit process and releases it', async () => {
		const harness = createHarness({ neighbors: [] });
		let lockDuringProcess: { userId: string; jobId: string } | null = null;
		const originalCreate = harness.closet.createClosetItem.bind(harness.closet);
		harness.closet.createClosetItem = async (params) => {
			lockDuringProcess = harness.closet.lock;
			return originalCreate(params);
		};

		await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(lockDuringProcess).toMatchObject({ userId: 'u1' });
		expect(harness.closet.lock).toBeNull();
		expect(harness.identity.upserts).toHaveLength(1);
	});

	it('processes crops sequentially under one writer lock', async () => {
		const harness = createHarness({
			items: [clothingItem(), clothingItem({ label: 'navy pants', category: ClothingItemCategory.BOTTOM })],
			neighbors: [],
		});
		const order: string[] = [];
		const originalPrepare = harness.identity.prepareClosetCrop;
		harness.identity.prepareClosetCrop = async () => {
			order.push(`prepare:${harness.closet.lock ? 'locked' : 'unlocked'}`);
			return originalPrepare();
		};

		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items).toHaveLength(2);
		expect(order).toEqual(['prepare:locked', 'prepare:locked']);
		expect(harness.closet.lock).toBeNull();
	});

	it('throws IdentityBusyError when another outfit writer holds the lock', async () => {
		const harness = createHarness({ neighbors: [] });
		harness.closet.lock = { userId: 'u1', jobId: 'other-job' };

		await expect(
			harness.processor.process({
				userId: 'u1',
				imageUrl: 'https://img/test.jpg',
				imageKey: 'users/u1/busy.jpg',
			})
		).rejects.toBeInstanceOf(IdentityBusyError);

		expect(harness.closet.lock).toEqual({ userId: 'u1', jobId: 'other-job' });
		expect(harness.closet.items).toHaveLength(0);
	});

	it('resolve-new commits D1 without taking the identity lock', async () => {
		const harness = createHarness({ neighbors: [] });
		harness.closet.lock = { userId: 'u1', jobId: 'outfit-writer' };
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'new',
		});

		expect(result.identity_status).toBe('created');
		expect(harness.closet.lock).toEqual({ userId: 'u1', jobId: 'outfit-writer' });
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.repairSends).toHaveLength(1);
	});

	it('resolve-same links without taking the identity lock', async () => {
		const harness = createHarness({ neighbors: [] });
		harness.closet.lock = { userId: 'u1', jobId: 'outfit-writer' };
		const match = seedPendingMatch(harness.closet);

		const result = await harness.processor.resolveMatch({
			userId: 'u1',
			matchId: match.id,
			decision: 'same',
		});

		expect(result.identity_status).toBe('created');
		expect(result.closet_item_id).toBe('c1');
		expect(harness.closet.lock).toEqual({ userId: 'u1', jobId: 'outfit-writer' });
		expect(harness.identity.upserts).toHaveLength(0);
		expect(harness.repairSends).toEqual([]);
	});
});

function clothingItem(overrides: Partial<ClothingItem> = {}): ClothingItem {
	return {
		label: 'olive shirt',
		category: ClothingItemCategory.TOP,
		subcategory: ClothingItemSubcategory.SHIRT,
		color: 'olive',
		pattern: ClothingItemPattern.SOLID,
		style_tags: [],
		confidence: ExtractionConfidence.HIGH,
		bounding_box: BOX,
		...overrides,
	};
}

function neighbor(overrides: Partial<QueryClosetCropMatch> = {}): QueryClosetCropMatch {
	return {
		id: 'item:c1',
		score: 0.96,
		closet_item_id: 'c1',
		d1_closet_item_id: 'c1',
		d1_label: 'olive shirt',
		color_distance: 0.03,
		identity_score: 0.77,
		...overrides,
	};
}

function queryResult(neighbors: QueryClosetCropMatch[]) {
	return {
		...PREPARED,
		neighbors,
		neighbor_count: neighbors.length,
		matches: neighbors.filter((n) => n.identity_score >= 0.5),
		match_count: neighbors.filter((n) => n.identity_score >= 0.5).length,
		probe_d1_closet_item_id: null,
		probe_d1_label: null,
	};
}

function createHarness(options: {
	items?: ClothingItem[];
	neighbors?: QueryClosetCropMatch[];
	requeryNeighbors?: QueryClosetCropMatch[];
	queryError?: Error;
	upsertError?: Error;
	upsertFailOnce?: boolean;
	d1Error?: Error;
	visible?: boolean;
	repairError?: Error;
	prepareError?: Error;
}) {
	const items = options.items ?? [clothingItem()];
	const extraction: OutfitExtractionResponse = {
		items,
		item_count: items.length,
		image_url: 'https://img/test.jpg',
		extracted_at: new Date().toISOString(),
		image_dimensions: { width: 1000, height: 1500 },
	};
	const closet = new MemoryCloset({ d1Error: options.d1Error });
	const identity = {
		prepares: 0,
		queries: 0,
		waits: 0,
		upserts: [] as Array<{ closetItemId?: string }>,
		deletes: [] as string[],
		prepareClosetCrop: async () => {
			identity.prepares += 1;
			if (options.prepareError) throw options.prepareError;
			return PREPARED;
		},
		queryPreparedCrop: async () => {
			identity.queries += 1;
			if (identity.queries === 1 && options.queryError) throw options.queryError;
			const neighbors =
				identity.queries === 1
					? (options.neighbors ?? [])
					: (options.requeryNeighbors ?? options.neighbors ?? []);
			return queryResult(neighbors);
		},
		upsertPreparedCrop: async (_embedded: PreparedClosetCrop, params: { closetItemId?: string }) => {
			identity.upserts.push({ closetItemId: params.closetItemId });
			if (options.upsertError && (!options.upsertFailOnce || identity.upserts.length === 1)) {
				throw options.upsertError;
			}
			return undefined as never;
		},
	};
	const digestSchedules: string[] = [];
	const catalogNotifies: Array<{
		userId: string;
		outfitId: string | null;
		items: Array<{ closet_item_id: string | null; identity_status: string }>;
	}> = [];
	const repairSends: unknown[] = [];
	const processor = new OutfitIdentityProcessor(
		{ extractOutfitItems: async () => extraction },
		identity as never,
		closet,
		silentLogger(),
		{ sleep: async () => {} },
		{
			schedule: async (userId) => {
				digestSchedules.push(userId);
			},
		},
		{
			notify: async (params) => {
				catalogNotifies.push({
					userId: params.userId,
					outfitId: params.outfitId,
					items: params.items.map((item) => ({
						closet_item_id: item.closet_item_id,
						identity_status: item.identity_status,
					})),
				});
			},
		},
		{
			send: async (job) => {
				if (options.repairError) throw options.repairError;
				repairSends.push(job);
			},
		}
	);
	return { processor, closet, identity, digestSchedules, catalogNotifies, repairSends };
}

	class MemoryCloset {
	outfits: Outfit[] = [];
	items: ClosetItem[] = [];
	links: Array<{
		outfitId: string;
		closetItemId: string;
		blurHash: string | null;
		boundingBox?: { x: number; y: number; width: number; height: number };
	}> = [];
	matches: ClosetItemMatch[] = [];
	askTouches: string[] = [];
	lock: { userId: string; jobId: string } | null = null;
	stealClaimAs: 'same' | 'new' | null = null;
	stealResolvedClosetItemId: string | null = null;

	constructor(private options: { d1Error?: Error } = {}) {}

	async tryAcquireIdentityLock(userId: string, jobId: string): Promise<boolean> {
		if (this.lock) return false;
		this.lock = { userId, jobId };
		return true;
	}

	async releaseIdentityLock(userId: string, jobId: string): Promise<void> {
		if (this.lock?.userId === userId && this.lock.jobId === jobId) {
			this.lock = null;
		}
	}

	async findClosetItemForPhotoCrop(): Promise<null> {
		return null;
	}

	async getClosetItemSummary(itemId: string) {
		const item = this.items.find((row) => row.id === itemId);
		return item
			? {
					id: item.id,
					user_id: item.user_id,
					label: item.label,
					category: item.category,
					vector_indexed_at: item.vector_indexed_at ?? null,
					index_status: item.index_status ?? null,
					index_attempts: item.index_attempts ?? 0,
				}
			: null;
	}

	async setClosetIndexStatus(
		itemId: string,
		status: 'committed' | 'indexing' | 'index_degraded',
		params?: { incrementAttempts?: boolean }
	): Promise<boolean> {
		const item = this.items.find((row) => row.id === itemId);
		if (!item || item.vector_indexed_at != null) return false;
		item.index_status = status;
		if (params?.incrementAttempts) {
			item.index_attempts = (item.index_attempts ?? 0) + 1;
		}
		return true;
	}

	async createOutfit(
		userId: string,
		imageUrl: string,
		imageKey: string,
		imageDimensions?: { width: number; height: number }
	): Promise<Outfit> {
		const outfit: Outfit = {
			id: `outfit-${this.outfits.length + 1}`,
			user_id: userId,
			original_image_url: imageUrl,
			image_key: imageKey,
			created_at: Date.now(),
			image_width: imageDimensions?.width ?? null,
			image_height: imageDimensions?.height ?? null,
		};
		this.outfits.push(outfit);
		return outfit;
	}

	async getOutfitByUserImageKey(userId: string, imageKey: string): Promise<Outfit | null> {
		return this.outfits.find((row) => row.user_id === userId && row.image_key === imageKey) ?? null;
	}

	async setOutfitImageDimensionsIfMissing(outfitId: string, width: number, height: number): Promise<void> {
		const outfit = this.outfits.find((row) => row.id === outfitId);
		if (!outfit || (outfit.image_width != null && outfit.image_height != null)) return;
		outfit.image_width = width;
		outfit.image_height = height;
	}

	async createClosetItem(params: {
		id?: string;
		userId: string;
		label: string;
		category: string;
		subcategory: string;
		color: string;
		pattern: string;
		styleTags: string[];
	}): Promise<ClosetItem> {
		if (this.options.d1Error) throw this.options.d1Error;
		const id = params.id?.trim() || `item-${this.items.length + 1}`;
		const existing = this.items.find((row) => row.id === id);
		if (existing) return existing;
		const item: ClosetItem = {
			id,
			user_id: params.userId,
			label: params.label,
			category: params.category,
			subcategory: params.subcategory,
			color: params.color,
			pattern: params.pattern,
			style_tags: params.styleTags,
			created_at: Date.now(),
			updated_at: Date.now(),
			vector_id: `item:${id}`,
			vector_indexed_at: null,
			index_status: 'committed',
			index_attempts: 0,
		};
		this.items.push(item);
		return item;
	}

	async linkClosetItemToOutfit(params: {
		outfitId: string;
		closetItemId: string;
		boundingBox?: { x: number; y: number; width: number; height: number };
		blurHash?: string | null;
	}): Promise<void> {
		const exists = this.links.some(
			(link) =>
				link.outfitId === params.outfitId &&
				link.closetItemId === params.closetItemId &&
				JSON.stringify(link.boundingBox ?? null) === JSON.stringify(params.boundingBox ?? null)
		);
		if (exists) return;
		this.links.push({
			outfitId: params.outfitId,
			closetItemId: params.closetItemId,
			blurHash: params.blurHash ?? null,
			boundingBox: params.boundingBox,
		});
	}

	async claimMatch(
		userId: string,
		matchId: string,
		params: { status: 'same' | 'new'; closetItemId: string }
	): Promise<boolean> {
		const match = this.matches.find((row) => row.id === matchId && row.user_id === userId);
		if (!match || match.status !== 'pending') return false;
		if (this.stealClaimAs) {
			match.status = this.stealClaimAs;
			match.resolved_at = Date.now();
			match.resolved_closet_item_id =
				this.stealClaimAs === 'same'
					? match.candidate_closet_item_id
					: (this.stealResolvedClosetItemId ?? match.resolved_closet_item_id ?? crypto.randomUUID());
			this.stealClaimAs = null;
			this.stealResolvedClosetItemId = null;
			return false;
		}
		match.status = params.status;
		match.resolved_at = Date.now();
		match.resolved_closet_item_id = params.closetItemId;
		return true;
	}

	async getLatestItemBlurHash(closetItemId: string): Promise<string | null> {
		for (let i = this.links.length - 1; i >= 0; i--) {
			const link = this.links[i];
			if (link.closetItemId === closetItemId && link.blurHash) return link.blurHash;
		}
		return null;
	}

	async createPendingMatch(params: {
		userId: string;
		outfitId: string;
		candidateClosetItemId: string;
		boundingBox: ClosetItemMatch['bounding_box'];
		confidence: string;
		extractSnapshot: ClosetItemMatch['extract_snapshot'];
		score: number;
		cosine?: number | null;
		colorDistance?: number | null;
		probeEmbed?: ClosetItemMatch['probe_embed'];
	}): Promise<ClosetItemMatch> {
		const match: ClosetItemMatch = {
			id: `match-${this.matches.length + 1}`,
			user_id: params.userId,
			outfit_id: params.outfitId,
			candidate_closet_item_id: params.candidateClosetItemId,
			bounding_box: params.boundingBox,
			confidence: params.confidence,
			extract_snapshot: params.extractSnapshot,
			score: params.score,
			cosine: params.cosine ?? null,
			color_distance: params.colorDistance ?? null,
			band: 'ask',
			status: 'pending',
			created_at: Date.now(),
			resolved_at: null,
			resolved_closet_item_id: null,
			probe_embed: params.probeEmbed ?? null,
		};
		this.matches.push(match);
		return match;
	}

	async getMatchWithOutfit(userId: string, matchId: string): Promise<ClosetItemMatchWithOutfit | null> {
		const match = this.matches.find((row) => row.id === matchId && row.user_id === userId);
		if (!match) return null;
		const outfit = this.outfits.find((row) => row.id === match.outfit_id);
		if (!outfit) return null;
		return {
			...match,
			outfit_image_key: outfit.image_key,
			outfit_original_image_url: outfit.original_image_url,
		};
	}

	async markMatchResolved(userId: string, matchId: string, status: 'same' | 'new'): Promise<boolean> {
		const match = this.matches.find((row) => row.id === matchId && row.user_id === userId);
		if (!match || match.status !== 'pending') return false;
		match.status = status;
		match.resolved_at = Date.now();
		return true;
	}

	async updatePendingMatch(
		userId: string,
		matchId: string,
		params: {
			candidateClosetItemId: string;
			score: number;
			cosine?: number | null;
			colorDistance?: number | null;
			probeEmbed?: ClosetItemMatch['probe_embed'];
		}
	): Promise<boolean> {
		const match = this.matches.find((row) => row.id === matchId && row.user_id === userId);
		if (!match || match.status !== 'pending') return false;
		match.candidate_closet_item_id = params.candidateClosetItemId;
		match.score = params.score;
		match.cosine = params.cosine ?? null;
		match.color_distance = params.colorDistance ?? null;
		if (params.probeEmbed !== undefined) {
			match.probe_embed = params.probeEmbed;
		}
		return true;
	}

	async touchMatchAsk(userId: string): Promise<void> {
		this.askTouches.push(userId);
	}
}

function seedPendingMatch(closet: MemoryCloset): ClosetItemMatch {
	const now = Date.now();
	closet.outfits.push({
		id: 'outfit-1',
		user_id: 'u1',
		original_image_url: 'https://img/test.jpg',
		image_key: 'users/u1/test.jpg',
		created_at: now,
		image_width: null,
		image_height: null,
	});
	closet.items.push({
		id: 'c1',
		user_id: 'u1',
		label: 'olive shirt',
		category: 'top',
		subcategory: 'shirt',
		color: 'olive',
		pattern: 'solid',
		style_tags: [],
		created_at: now,
		updated_at: now,
	});
	const match: ClosetItemMatch = {
		id: 'match-1',
		user_id: 'u1',
		outfit_id: 'outfit-1',
		candidate_closet_item_id: 'c1',
		bounding_box: BOX,
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
		status: 'pending',
		created_at: now,
		resolved_at: null,
		resolved_closet_item_id: null,
		probe_embed: closetMatchProbeFromPrepared(PREPARED),
	};
	closet.matches.push(match);
	return match;
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
