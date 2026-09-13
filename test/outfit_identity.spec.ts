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
	OutfitIdentityProcessor,
	candidateClosetItemId,
	decideCommitAfterRequery,
	decideIdentityFromNeighbors,
	shouldQueryIdentity,
} from '../src/services/identity/processOutfitImage';
import type { PreparedClosetCrop, QueryClosetCropMatch } from '../src/services/identity';
import type { ClosetItem, ClosetItemMatch, Outfit } from '../src/db/closet';
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
		expect(harness.closet.matches).toHaveLength(0);
		expect(harness.identity.upserts).toHaveLength(1);
		expect(harness.identity.upserts[0].closetItemId).toBe(result?.items[0].closet_item_id);
		expect(harness.identity.prepares).toBe(1);
		expect(harness.identity.deletes).toHaveLength(0);
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

	it('does not create a closet tile when vector upsert fails', async () => {
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
			identity_status: 'failed',
			identity_reason: 'upsert_failed',
			is_new_closet_item: false,
			closet_item_id: null,
		});
		expect(harness.closet.items).toHaveLength(0);
		expect(harness.closet.links).toHaveLength(0);
		expect(harness.identity.upserts).toHaveLength(1);
	});

	it('deletes the vector and skips D1 when getByIds never sees the upsert', async () => {
		const harness = createHarness({ neighbors: [], visible: false });
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_reason).toBe('visibility_timeout');
		expect(harness.closet.items).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(1);
	});

	it('deletes the vector and asks when re-query finds a committed neighbor', async () => {
		const harness = createHarness({
			neighbors: [],
			requeryNeighbors: [neighbor({ identity_score: 0.77 })],
		});
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0]).toMatchObject({
			identity_status: 'ask',
			candidate_closet_item_id: 'c1',
		});
		expect(harness.closet.items).toHaveLength(0);
		expect(harness.closet.matches).toHaveLength(1);
		expect(harness.identity.deletes).toHaveLength(1);
	});

	it('deletes the vector when D1 insert fails', async () => {
		const harness = createHarness({ neighbors: [], d1Error: new Error('d1 down') });
		const result = await harness.processor.process({
			userId: 'u1',
			imageUrl: 'https://img/test.jpg',
			imageKey: 'users/u1/test.jpg',
		});

		expect(result?.items[0].identity_reason).toBe('d1_failed');
		expect(harness.closet.items).toHaveLength(0);
		expect(harness.identity.deletes).toHaveLength(1);
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
	neighbors?: QueryClosetCropMatch[];
	requeryNeighbors?: QueryClosetCropMatch[];
	queryError?: Error;
	upsertError?: Error;
	d1Error?: Error;
	visible?: boolean;
}) {
	const extraction: OutfitExtractionResponse = {
		items: [clothingItem()],
		item_count: 1,
		image_url: 'https://img/test.jpg',
		extracted_at: new Date().toISOString(),
		image_dimensions: { width: 1000, height: 1500 },
	};
	const closet = new MemoryCloset({ d1Error: options.d1Error });
	const identity = {
		prepares: 0,
		queries: 0,
		upserts: [] as Array<{ closetItemId?: string }>,
		deletes: [] as string[],
		prepareClosetCrop: async () => {
			identity.prepares += 1;
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
			if (options.upsertError) throw options.upsertError;
			return undefined as never;
		},
		waitUntilVectorVisible: async () => options.visible !== false,
		deleteVector: async (vectorId: string) => {
			identity.deletes.push(vectorId);
		},
	};
	const processor = new OutfitIdentityProcessor(
		{ extractOutfitItems: async () => extraction },
		identity as never,
		closet,
		silentLogger(),
		{ timeoutMs: 0, pollMs: 0, now: Date.now, sleep: async () => {} }
	);
	return { processor, closet, identity };
}

class MemoryCloset {
	outfits: Outfit[] = [];
	items: ClosetItem[] = [];
	links: Array<{ outfitId: string; closetItemId: string }> = [];
	matches: ClosetItemMatch[] = [];
	lock: { userId: string; jobId: string } | null = null;

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
		return item ? { id: item.id, label: item.label, category: item.category } : null;
	}

	async createOutfit(userId: string, imageUrl: string, imageKey: string): Promise<Outfit> {
		const outfit: Outfit = {
			id: `outfit-${this.outfits.length + 1}`,
			user_id: userId,
			original_image_url: imageUrl,
			image_key: imageKey,
			created_at: Date.now(),
		};
		this.outfits.push(outfit);
		return outfit;
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
		const item: ClosetItem = {
			id: params.id?.trim() || `item-${this.items.length + 1}`,
			user_id: params.userId,
			label: params.label,
			category: params.category,
			subcategory: params.subcategory,
			color: params.color,
			pattern: params.pattern,
			style_tags: params.styleTags,
			created_at: Date.now(),
			updated_at: Date.now(),
		};
		this.items.push(item);
		return item;
	}

	async linkClosetItemToOutfit(params: { outfitId: string; closetItemId: string }): Promise<void> {
		this.links.push({ outfitId: params.outfitId, closetItemId: params.closetItemId });
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
		};
		this.matches.push(match);
		return match;
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
