import { describe, expect, it } from 'vitest';
import {
	decideOutfitPriorAsk,
	isOutfitPriorRescueable,
	OUTFIT_PRIOR_ASK_MIN,
	OUTFIT_PRIOR_HIT_MIN,
	selectPriorOutfitId,
} from '../src/services/identity/decide/outfitPrior';
import type { PreparedClosetCrop } from '../src/services/identity/encode/cropEncoder';
import { closetMatchProbeFromPrepared } from '../src/services/identity/encode/probeEmbed';
import {
	ClothingItemCategory,
	ClothingItemPattern,
	ClothingItemSubcategory,
	ExtractionConfidence,
} from '../src/types';
import { OutfitIdentityProcessor } from '../src/services/identity/write/processOutfit';
import type { ClosetItem, ClosetItemMatch, Outfit } from '../src/db/closet';
import type { Logger } from '../src/utils/logger.utils';
import type { QueryClosetCropMatch } from '../src/services/identity/encode/cropEncoder';

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
	crop_color: { h: 40, s: 0.2, l: 0.4 },
	crop_blur_hash: null,
	vector: Array(1024).fill(0.1),
};

describe('selectPriorOutfitId', () => {
	it('requires two strong hits on the same prior outfit', () => {
		const memberships = new Map([
			['c-jacket', ['outfit-prior']],
			['c-jeans', ['outfit-prior']],
			['c-other', ['outfit-other']],
		]);
		expect(
			selectPriorOutfitId(
				[
					{ candidateClosetItemId: 'c-jacket', identityScore: 0.9 },
					{ candidateClosetItemId: 'c-jeans', identityScore: 0.85 },
				],
				memberships
			)
		).toBe('outfit-prior');
		expect(
			selectPriorOutfitId(
				[{ candidateClosetItemId: 'c-jacket', identityScore: 0.9 }],
				memberships
			)
		).toBeNull();
		expect(
			selectPriorOutfitId(
				[
					{ candidateClosetItemId: 'c-jacket', identityScore: OUTFIT_PRIOR_HIT_MIN - 0.01 },
					{ candidateClosetItemId: 'c-jeans', identityScore: 0.9 },
				],
				memberships
			)
		).toBeNull();
	});
});

describe('decideOutfitPriorAsk', () => {
	it('asks against a prior-outfit tile above the relaxed floor', () => {
		const probe = closetMatchProbeFromPrepared(PREPARED)!;
		const decision = decideOutfitPriorAsk({
			prepared: PREPARED,
			probes: [
				{
					closetItemId: 'c-boots',
					category: 'footwear',
					subcategory: 'boots',
					label: 'black boots',
					probeEmbed: probe,
				},
			],
			category: 'footwear',
		});
		expect(decision).toMatchObject({
			action: 'ask',
			reason: 'outfit_prior',
			candidateClosetItemId: 'c-boots',
		});
		expect(decision!.identityScore).toBeGreaterThanOrEqual(OUTFIT_PRIOR_ASK_MIN);
	});

	it('returns null when prior outfit has no probes', () => {
		expect(
			decideOutfitPriorAsk({
				prepared: PREPARED,
				probes: [],
				category: 'footwear',
			})
		).toBeNull();
	});
});

describe('isOutfitPriorRescueable', () => {
	it('only rescues soft misses (not empty-closet no_neighbor)', () => {
		expect(isOutfitPriorRescueable({ action: 'create', reason: 'below_threshold' })).toBe(true);
		expect(isOutfitPriorRescueable({ action: 'create', reason: 'missing_candidate' })).toBe(true);
		expect(isOutfitPriorRescueable({ action: 'create', reason: 'no_neighbor' })).toBe(false);
		expect(isOutfitPriorRescueable({ action: 'create', reason: 'identity_error' })).toBe(false);
	});
});

describe('OutfitIdentityProcessor outfit prior', () => {
	it('rescues a below-threshold item when ≥2 high asks share a prior outfit', async () => {
		const jacket = neighbor({
			id: 'item:c-jacket',
			closet_item_id: 'c-jacket',
			d1_closet_item_id: 'c-jacket',
			identity_score: 0.9,
			score: 0.98,
		});
		const jeans = neighbor({
			id: 'item:c-jeans',
			closet_item_id: 'c-jeans',
			d1_closet_item_id: 'c-jeans',
			identity_score: 0.88,
			score: 0.97,
		});
		const harness = createPriorHarness({
			neighborByLabel: {
				jacket: [jacket],
				jeans: [jeans],
				boots: [neighbor({ identity_score: 0.2, score: 0.7 })],
			},
		});
		seedPriorOutfit(harness.closet);

		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/new.jpg',
			imageKey: 'users/u1/new.jpg',
		});

		expect(result?.items).toHaveLength(3);
		expect(result?.items[0]).toMatchObject({
			label: 'jacket',
			identity_status: 'ask',
			candidate_closet_item_id: 'c-jacket',
		});
		expect(result?.items[1]).toMatchObject({
			label: 'jeans',
			identity_status: 'ask',
			candidate_closet_item_id: 'c-jeans',
		});
		expect(result?.items[2]).toMatchObject({
			label: 'boots',
			identity_status: 'ask',
			identity_reason: 'outfit_prior',
			candidate_closet_item_id: 'c-boots',
		});
		expect(harness.closet.matches).toHaveLength(3);
	});
});

function neighbor(overrides: Partial<QueryClosetCropMatch> = {}): QueryClosetCropMatch {
	return {
		id: 'item:c1',
		score: 0.96,
		closet_item_id: 'c1',
		d1_closet_item_id: 'c1',
		d1_label: 'item',
		d1_subcategory: 'shirt',
		color_distance: 0.03,
		identity_score: 0.77,
		...overrides,
	};
}

function clothing(label: string, category: string, subcategory: string) {
	return {
		label,
		category: category as never,
		subcategory: subcategory as never,
		color: 'black',
		pattern: ClothingItemPattern.SOLID,
		style_tags: [],
		confidence: ExtractionConfidence.HIGH,
		bounding_box: { x: 10, y: 10, width: 40, height: 40 },
	};
}

function seedPriorOutfit(closet: MemoryClosetPrior) {
	const now = Date.now();
	closet.outfits.push({
		id: 'outfit-prior',
		user_id: 'u1',
		original_image_url: 'https://img/prior.jpg',
		image_key: 'users/u1/prior.jpg',
		created_at: now,
		image_width: 1000,
		image_height: 1500,
	});
	for (const [id, label, category, subcategory] of [
		['c-jacket', 'jacket', 'outerwear', 'jacket'],
		['c-jeans', 'jeans', 'bottom', 'jeans'],
		['c-boots', 'boots', 'footwear', 'boots'],
	] as const) {
		closet.items.push({
			id,
			user_id: 'u1',
			label,
			category,
			subcategory,
			color: 'black',
			pattern: 'solid',
			style_tags: [],
			created_at: now,
			updated_at: now,
		});
		closet.links.push({
			outfitId: 'outfit-prior',
			closetItemId: id,
			blurHash: null,
			boundingBox: { x: 10, y: 10, width: 40, height: 40 },
		});
		closet.probeEmbeds[id] = closetMatchProbeFromPrepared(PREPARED)!;
	}
}

function createPriorHarness(options: {
	neighborByLabel: Record<string, QueryClosetCropMatch[]>;
}) {
	const items = [
		clothing('jacket', ClothingItemCategory.OUTERWEAR, ClothingItemSubcategory.JACKET),
		clothing('jeans', ClothingItemCategory.BOTTOM, ClothingItemSubcategory.JEANS),
		clothing('boots', ClothingItemCategory.FOOTWEAR, ClothingItemSubcategory.BOOTS),
	];
	const extraction = {
		items,
		item_count: 3,
		image_url: 'https://img/new.jpg',
		extracted_at: new Date().toISOString(),
		image_dimensions: { width: 1000, height: 1500 },
	};
	const closet = new MemoryClosetPrior();
	let queryCount = 0;
	const identity = {
		prepareClosetCrop: async () => PREPARED,
		queryPreparedCrop: async () => {
			queryCount += 1;
			const label = items[queryCount - 1]?.label ?? '';
			const neighbors = options.neighborByLabel[label] ?? [];
			return {
				...PREPARED,
				matches: neighbors.filter((n) => n.identity_score >= 0.5),
				match_count: neighbors.filter((n) => n.identity_score >= 0.5).length,
				neighbors,
				neighbor_count: neighbors.length,
				probe_d1_closet_item_id: null,
				probe_d1_label: null,
			};
		},
		upsertPreparedCrop: async () => undefined as never,
		getVectorsByIds: async (ids: string[]) => ids.map((id) => ({ id })),
	};
	const processor = new OutfitIdentityProcessor(
		{ extractOutfitItems: async () => extraction },
		identity as never,
		closet,
		silentLogger(),
		{ timeoutMs: 0, pollMs: 0, now: Date.now, sleep: async () => {} }
	);
	return { processor, closet };
}

class MemoryClosetPrior {
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
	probeEmbeds: Record<string, NonNullable<ClosetItemMatch['probe_embed']>> = {};

	async tryAcquireIdentityLock(userId: string, jobId: string) {
		if (this.lock) return false;
		this.lock = { userId, jobId };
		return true;
	}
	async releaseIdentityLock(userId: string, jobId: string) {
		if (this.lock?.userId === userId && this.lock.jobId === jobId) this.lock = null;
	}
	async findClosetItemForPhotoCrop() {
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
					subcategory: item.subcategory,
					vector_indexed_at: null,
					index_status: null,
					index_attempts: 0,
				}
			: null;
	}
	async setClosetIndexStatus() {
		return true;
	}
	async stampVectorIndexedAt() {
		return true;
	}
	async listPendingIndexClosetItemIdsForUser() {
		return [];
	}
	async listRecentUnindexedProbes() {
		return [];
	}
	async listRecentPendingMatchProbes() {
		return [];
	}
	async listOutfitIdsForClosetItems(
		userId: string,
		closetItemIds: readonly string[],
		excludeOutfitId?: string
	) {
		const wanted = new Set(closetItemIds);
		const rows: Array<{ closet_item_id: string; outfit_id: string }> = [];
		for (const link of this.links) {
			if (!wanted.has(link.closetItemId)) continue;
			if (excludeOutfitId && link.outfitId === excludeOutfitId) continue;
			const outfit = this.outfits.find((row) => row.id === link.outfitId);
			if (!outfit || outfit.user_id !== userId) continue;
			rows.push({ closet_item_id: link.closetItemId, outfit_id: link.outfitId });
		}
		return rows;
	}
	async listOutfitTileProbes(outfitId: string) {
		return this.links
			.filter((link) => link.outfitId === outfitId && Boolean(this.probeEmbeds[link.closetItemId]))
			.map((link) => {
				const item = this.items.find((row) => row.id === link.closetItemId)!;
				return {
					closetItemId: link.closetItemId,
					category: item.category,
					subcategory: item.subcategory,
					label: item.label,
					probeEmbed: this.probeEmbeds[link.closetItemId],
				};
			});
	}
	async createOutfit(userId: string, imageUrl: string, imageKey: string, dims?: { width: number; height: number }) {
		const outfit: Outfit = {
			id: `outfit-${this.outfits.length + 1}`,
			user_id: userId,
			original_image_url: imageUrl,
			image_key: imageKey,
			created_at: Date.now(),
			image_width: dims?.width ?? null,
			image_height: dims?.height ?? null,
		};
		this.outfits.push(outfit);
		return outfit;
	}
	async getOutfitByUserImageKey(userId: string, imageKey: string) {
		return this.outfits.find((row) => row.user_id === userId && row.image_key === imageKey) ?? null;
	}
	async setOutfitImageDimensionsIfMissing() {}
	async createClosetItem() {
		throw new Error('should not create during prior rescue');
	}
	async linkClosetItemToOutfit() {}
	async getLatestItemBlurHash() {
		return null;
	}
	async createPendingMatch(params: {
		userId: string;
		outfitId: string;
		candidateClosetItemId: string;
		boundingBox: { x: number; y: number; width: number; height: number };
		confidence: string;
		extractSnapshot: ClosetItemMatch['extract_snapshot'];
		score: number;
		cosine: number | null;
		colorDistance: number | null;
		probeEmbed: ClosetItemMatch['probe_embed'];
	}) {
		const match: ClosetItemMatch = {
			id: `match-${this.matches.length + 1}`,
			user_id: params.userId,
			outfit_id: params.outfitId,
			candidate_closet_item_id: params.candidateClosetItemId,
			bounding_box: params.boundingBox,
			confidence: params.confidence,
			extract_snapshot: params.extractSnapshot,
			score: params.score,
			cosine: params.cosine,
			color_distance: params.colorDistance,
			band: 'ask',
			status: 'pending',
			created_at: Date.now(),
			resolved_at: null,
			resolved_closet_item_id: null,
			probe_embed: params.probeEmbed,
		};
		this.matches.push(match);
		return match;
	}
	async updatePendingMatch() {
		return true;
	}
	async touchMatchAsk(userId: string) {
		this.askTouches.push(userId);
	}
	async getMatchWithOutfit() {
		return null;
	}
	async claimMatch() {
		return true;
	}
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
