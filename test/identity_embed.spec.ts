import { describe, it, expect } from 'vitest';
import { parseJinaEmbedding } from '../src/services/identity/encode/providers/jina.provider';
import {
	imageToReplicateUri,
	parseDinoClsEmbedding,
	resolveDinoModel,
	throttleRetryDelayMs,
} from '../src/services/identity/encode/providers/replicate.provider';
import {
	VECTORIZE_INDEX_DIMENSIONS,
	DEFAULT_DINO_EMBED_MODEL,
	DEFAULT_DINO_EMBED_VERSION,
	IDENTITY_ENCODER,
} from '../src/services/identity/encode/embed.types';
import {
	rgbaToColorSignature,
	cropColorDistance,
	identityScore,
	identityColorFullPenalty,
	isDarkNeutral,
	isDarkNeutralPair,
	decodePngRgba,
	COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL,
} from '../src/services/identity/encode/cropColor';
import { resolveIdentitySlot } from '../src/services/identity/encode/slot';
import {
	assertEmbeddingDimensions,
	buildClosetQueryFilter,
	buildClosetVectorMetadata,
	clampTopK,
	closetItemVectorId,
	closetWearVectorId,
	ClosetVectorStore,
	randomUnitEmbedding,
	resolveClosetVectorId,
} from '../src/services/identity/encode/vectorize.store';

describe('parseDinoClsEmbedding', () => {
	it('takes the CLS token from batched last_hidden_state', () => {
		const cls = Array.from({ length: VECTORIZE_INDEX_DIMENSIONS }, (_, i) => i);
		const patch = Array.from({ length: VECTORIZE_INDEX_DIMENSIONS }, () => 0);
		expect(parseDinoClsEmbedding([[cls, patch, patch]])).toEqual(cls);
	});

	it('accepts a pooled CLS vector', () => {
		const pooled = Array.from({ length: VECTORIZE_INDEX_DIMENSIONS }, (_, i) => i * 0.01);
		expect(parseDinoClsEmbedding(pooled)).toEqual(pooled);
		expect(parseDinoClsEmbedding([pooled])).toEqual(pooled);
	});

	it('accepts a JSON string or embedding object', () => {
		const pooled = Array.from({ length: VECTORIZE_INDEX_DIMENSIONS }, (_, i) => i * 0.01);
		expect(parseDinoClsEmbedding(JSON.stringify(pooled))).toEqual(pooled);
		expect(parseDinoClsEmbedding({ embedding: pooled })).toEqual(pooled);
	});

	it('rejects empty payloads', () => {
		expect(() => parseDinoClsEmbedding({ error: 'loading' })).toThrow(/loading/);
		expect(() => parseDinoClsEmbedding([])).toThrow(/numeric vector/);
	});
});

describe('resolveDinoModel', () => {
	it('pins the community Cog version by default', () => {
		expect(resolveDinoModel()).toEqual({
			model: DEFAULT_DINO_EMBED_MODEL,
			version: DEFAULT_DINO_EMBED_VERSION,
		});
		expect(resolveDinoModel('facebook/dinov2-base')).toEqual({
			model: DEFAULT_DINO_EMBED_MODEL,
			version: DEFAULT_DINO_EMBED_VERSION,
		});
	});

	it('accepts owner/name:version', () => {
		expect(resolveDinoModel('acme/dino:abc123')).toEqual({ model: 'acme/dino', version: 'abc123' });
	});
});

describe('imageToReplicateUri', () => {
	it('prefers an https crop URL over base64', () => {
		const bytes = new Uint8Array([1, 2, 3]).buffer;
		expect(
			imageToReplicateUri({
				imageUrl: 'https://bucket.example.r2.cloudflarestorage.com/crop.jpg',
				imageBytes: bytes,
				contentType: 'image/jpeg',
			})
		).toBe('https://bucket.example.r2.cloudflarestorage.com/crop.jpg');
	});

	it('falls back to a data URI when preferBytes is set', () => {
		const bytes = new Uint8Array([1, 2, 3]).buffer;
		expect(
			imageToReplicateUri(
				{
					imageUrl: 'https://bucket.example.r2.cloudflarestorage.com/crop.jpg',
					imageBytes: bytes,
					contentType: 'image/jpeg',
				},
				true
			)
		).toBe('data:image/jpeg;base64,AQID');
	});
});

describe('throttleRetryDelayMs', () => {
	it('honors Replicate reset hints with a floor', () => {
		expect(throttleRetryDelayMs('rate limit resets in ~4s.', 0)).toBeGreaterThanOrEqual(11_000);
		expect(throttleRetryDelayMs('rate limit resets in ~4s.', 1)).toBeGreaterThan(
			throttleRetryDelayMs('rate limit resets in ~4s.', 0)
		);
	});
});

describe('parseJinaEmbedding', () => {
	it('reads a numeric vector and model', () => {
		const vector = Array.from({ length: VECTORIZE_INDEX_DIMENSIONS }, (_, i) => i * 0.001);
		const parsed = parseJinaEmbedding(
			{ model: 'jina-clip-v2', data: [{ embedding: vector }] },
			'fallback'
		);
		expect(parsed.model).toBe('jina-clip-v2');
		expect(parsed.dimensions).toBe(VECTORIZE_INDEX_DIMENSIONS);
		expect(parsed.vector[0]).toBe(0);
		expect(parsed.vector[1]).toBe(0.001);
	});

	it('rejects a missing or non-numeric embedding', () => {
		expect(() => parseJinaEmbedding({ data: [] }, 'jina-clip-v2')).toThrow(/numeric vector/);
		expect(() => parseJinaEmbedding({ data: [{ embedding: ['x'] }] }, 'jina-clip-v2')).toThrow(
			/numeric vector/
		);
	});
});

describe('closet vector ids', () => {
	it('namespaces closet item ids', () => {
		expect(closetItemVectorId('abc-123')).toBe('item:abc-123');
		expect(closetWearVectorId('match-uuid')).toBe('wear:match-uuid');
	});

	it('prefers an explicit id, then closetItemId, then a scratch uuid', () => {
		expect(resolveClosetVectorId({ id: 'scratch:tee-a', closetItemId: 'ignored' })).toBe('scratch:tee-a');
		expect(resolveClosetVectorId({ closetItemId: 'wear-1' })).toBe('item:wear-1');
		expect(resolveClosetVectorId({})).toMatch(/^scratch:[0-9a-f-]{36}$/);
	});

	it('rejects ids over 64 bytes', () => {
		expect(() => resolveClosetVectorId({ id: 'x'.repeat(65) })).toThrow(/64-byte limit/);
	});
});

describe('closet vector metadata', () => {
	it('lowercases category, maps slot, and pins encoder', () => {
		expect(
			buildClosetVectorMetadata({ userId: 'u1', category: 'Tops', closetItemId: 'c1' })
		).toEqual({
			user_id: 'u1',
			slot: 'upper',
			encoder: IDENTITY_ENCODER,
			category: 'tops',
			closet_item_id: 'c1',
		});
		expect(() => buildClosetVectorMetadata({ userId: ' ', category: 'tops', closetItemId: 'c1' })).toThrow(
			/userId is required/
		);
	});

	it('filters by user, slot, and encoder — never extract category', () => {
		expect(buildClosetQueryFilter({ userId: 'u1', slot: 'upper', encoder: IDENTITY_ENCODER })).toEqual({
			user_id: 'u1',
			slot: 'upper',
			encoder: IDENTITY_ENCODER,
		});
		expect(buildClosetQueryFilter({})).toBeUndefined();
	});

	it('rejects embeddings that do not match the index', () => {
		expect(() => assertEmbeddingDimensions([0.1, 0.2])).toThrow(/does not match Vectorize index 1024/);
		expect(() => assertEmbeddingDimensions(Array(VECTORIZE_INDEX_DIMENSIONS).fill(0.1))).not.toThrow();
	});

	it('clamps topK', () => {
		expect(clampTopK(undefined)).toBe(10);
		expect(clampTopK(0)).toBe(1);
		expect(clampTopK(99)).toBe(20);
	});
});

describe('identity slot', () => {
	it('maps extract categories to a coarse body region', () => {
		expect(resolveIdentitySlot('outerwear')).toBe('upper');
		expect(resolveIdentitySlot('top')).toBe('upper');
		expect(resolveIdentitySlot('bottom')).toBe('lower');
		expect(resolveIdentitySlot('footwear')).toBe('footwear');
		expect(resolveIdentitySlot('accessory')).toBe('accessory');
		expect(resolveIdentitySlot('full-body')).toBe('full_body');
		expect(resolveIdentitySlot('jeans')).toBeUndefined();
	});
});

describe('ClosetVectorStore', () => {
	it('upserts with metadata and queries with a user/slot/encoder filter', async () => {
		let lastQuery: { options?: VectorizeQueryOptions } | undefined;
		const index = {
			upsert: async (vectors: VectorizeVector[]) => ({
				ids: vectors.map((vector) => vector.id),
				count: vectors.length,
			}),
			query: async (_vector: number[], options?: VectorizeQueryOptions) => {
				lastQuery = { options };
				return {
					count: 1,
					matches: [
						{
							id: 'item:c1',
							score: 0.91,
							metadata: {
								user_id: 'u1',
								slot: 'upper',
								encoder: IDENTITY_ENCODER,
								category: 'tops',
								closet_item_id: 'c1',
							},
						},
					],
				};
			},
		};
		const store = new ClosetVectorStore(index as unknown as VectorizeIndex);
		const values = Array(VECTORIZE_INDEX_DIMENSIONS).fill(0.1);
		await expect(
			store.upsert('item:c1', values, {
				user_id: 'u1',
				slot: 'upper',
				encoder: IDENTITY_ENCODER,
				category: 'tops',
				closet_item_id: 'c1',
			})
		).resolves.toEqual({ ids: ['item:c1'], count: 1 });

		const queried = await store.querySimilar(values, {
			userId: 'u1',
			slot: 'upper',
			encoder: IDENTITY_ENCODER,
			topK: 5,
		});
		expect(lastQuery?.options).toEqual({
			topK: 5,
			returnMetadata: 'all',
			filter: { user_id: 'u1', slot: 'upper', encoder: IDENTITY_ENCODER },
		});
		expect(queried.matches[0]).toEqual({
			id: 'item:c1',
			score: 0.91,
			closet_item_id: 'c1',
			metadata: {
				user_id: 'u1',
				slot: 'upper',
				encoder: IDENTITY_ENCODER,
				category: 'tops',
				closet_item_id: 'c1',
			},
		});
	});

	it('gets and deletes vectors by id', async () => {
		const deleted: string[][] = [];
		const index = {
			getByIds: async (ids: string[]) => (ids.includes('item:c1') ? [{ id: 'item:c1', values: [0.1] }] : []),
			deleteByIds: async (ids: string[]) => {
				deleted.push(ids);
				return { ids, count: ids.length };
			},
		};
		const store = new ClosetVectorStore(index as unknown as VectorizeIndex);
		await expect(store.getByIds(['item:c1'])).resolves.toEqual([{ id: 'item:c1', values: [0.1] }]);
		await expect(store.deleteByIds(['item:c1'])).resolves.toEqual({ ids: ['item:c1'], count: 1 });
		expect(deleted).toEqual([['item:c1']]);
	});

	it('sweeps deleteByUserId until a query round is empty', async () => {
		const deleted: string[][] = [];
		let queries = 0;
		const index = {
			query: async (_vector: number[], options?: VectorizeQueryOptions) => {
				queries += 1;
				expect(_vector).toHaveLength(VECTORIZE_INDEX_DIMENSIONS);
				expect(options?.filter).toEqual({ user_id: 'u-eval' });
				expect(options?.topK).toBe(100);
				if (queries === 1) {
					return {
						count: 2,
						matches: [
							{ id: 'item:a', score: 0.1 },
							{ id: 'item:b', score: 0.2 },
						],
					};
				}
				return { count: 0, matches: [] };
			},
			deleteByIds: async (ids: string[]) => {
				deleted.push(ids);
				return { ids, count: ids.length };
			},
		};
		const store = new ClosetVectorStore(index as unknown as VectorizeIndex);
		await expect(store.deleteByUserId('u-eval')).resolves.toEqual({ deleted: 2, failed: 0, rounds: 1 });
		expect(deleted).toEqual([['item:a', 'item:b']]);
		expect(randomUnitEmbedding()).toHaveLength(VECTORIZE_INDEX_DIMENSIONS);
	});
});

describe('crop color identity', () => {
	it('separates olive from black even when cosine is similar', () => {
		const olive = rgbaToColorSignature(flatRgba(112, 128, 64));
		const black = rgbaToColorSignature(flatRgba(24, 24, 28));
		expect(cropColorDistance(olive, black)).toBeGreaterThan(0.35);
		expect(identityScore(0.96, cropColorDistance(olive, black))).toBeLessThan(0.5);
	});

	it('ignores skin and grey tee when scoring black vs olive selfies', () => {
		const skin = { r: 180, g: 118, b: 88 };
		const grey = { r: 142, g: 142, b: 148 };
		const black = mixRgba([
			{ ...skin, n: 8 },
			{ ...grey, n: 4 },
			{ r: 22, g: 22, b: 24, n: 20 },
		]);
		const olive = mixRgba([
			{ ...skin, n: 8 },
			{ ...grey, n: 4 },
			{ r: 90, g: 112, b: 64, n: 20 },
		]);
		const distance = cropColorDistance(rgbaToColorSignature(black), rgbaToColorSignature(olive));
		expect(distance).toBeGreaterThan(0.3);
		expect(identityScore(0.96, distance)).toBeLessThan(0.5);
		expect(
			identityScore(
				0.96,
				distance,
				identityColorFullPenalty(rgbaToColorSignature(black), rgbaToColorSignature(olive))
			)
		).toBeLessThan(0.5);
	});

	it('keeps lighting-shift Δ above the ask floor and kills real color changes', () => {
		// Same garment, different light (smoke: light jeans Δ0.09 @ cos 0.996, navy cap Δ0.166 @ 0.986).
		expect(identityScore(0.96, 0.032)).toBeGreaterThan(0.5);
		expect(identityScore(0.996, 0.09)).toBeGreaterThan(0.5);
		expect(identityScore(0.986, 0.166)).toBeGreaterThan(0.5);
		// Different garments in the same slot observed at Δ ≥ 0.35 (hoodie vs leather, grey vs beige).
		expect(identityScore(0.975, 0.352)).toBeLessThan(0.5);
		expect(identityScore(0.97, 0.407)).toBeLessThan(0.5);
	});

	it('ignores hue for low-chroma pairs (WB flip) while keeping olive vs black hard', () => {
		const warmDark = { h: 23, s: 0.14, l: 0.29 };
		const coolDark = { h: 219, s: 0.24, l: 0.21 };
		// Apr3 jacket-style signatures: large hue gap, modest L/S — must not floor-kill.
		expect(cropColorDistance(warmDark, coolDark)).toBeLessThan(0.25);
		expect(identityScore(0.999, cropColorDistance(warmDark, coolDark))).toBeGreaterThan(0.5);
		const olive = rgbaToColorSignature(flatRgba(112, 128, 64));
		const black = rgbaToColorSignature(flatRgba(24, 24, 28));
		expect(cropColorDistance(olive, black)).toBeGreaterThan(0.35);
		expect(identityScore(0.96, cropColorDistance(olive, black))).toBeLessThan(0.5);
	});

	it('weights crop center over edges so wall/floor borders do not shift the color', () => {
		const black = { r: 22, g: 22, b: 24 };
		const floor = { r: 120, g: 130, b: 150 }; // cool grey-blue floor: passes skin + background filters
		const size = 16;
		const rgba = new Uint8Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const edge = x < 3 || x >= size - 3 || y < 3 || y >= size - 3;
				const c = edge ? floor : black;
				rgba.set([c.r, c.g, c.b, 255], (y * size + x) * 4);
			}
		}
		const flat = rgbaToColorSignature(rgba);
		const weighted = rgbaToColorSignature(rgba, { width: size, height: size });
		expect(weighted.l).toBeLessThan(flat.l);
		expect(weighted.s).toBeLessThan(flat.s);
		expect(isDarkNeutral(weighted)).toBe(true);
	});

	it('drops the floor band under footwear crops', () => {
		const black = { r: 22, g: 22, b: 24 };
		const floor = { r: 120, g: 130, b: 150 };
		const size = 16;
		const rgba = new Uint8Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const c = y >= 12 ? floor : black;
				rgba.set([c.r, c.g, c.b, 255], (y * size + x) * 4);
			}
		}
		const generic = rgbaToColorSignature(rgba, { width: size, height: size, category: 'top' });
		const footwear = rgbaToColorSignature(rgba, { width: size, height: size, category: 'footwear' });
		expect(footwear.l).toBeLessThan(generic.l);
		expect(footwear.l).toBeLessThan(0.12);
		expect(footwear.s).toBeLessThan(0.1);
	});

	it('allows black vs dark-gray under lighting shift at high cosine', () => {
		const black = rgbaToColorSignature(flatRgba(22, 22, 24));
		const darkGray = rgbaToColorSignature(flatRgba(58, 58, 62));
		expect(isDarkNeutral(black)).toBe(true);
		expect(isDarkNeutral(darkGray)).toBe(true);
		const distance = cropColorDistance(black, darkGray);
		// Must not force the olive-scale 0.45 floor.
		expect(distance).toBeLessThan(0.35);
		const score = identityScore(0.98, distance, identityColorFullPenalty(black, darkGray));
		expect(score).toBeGreaterThanOrEqual(0.5);
	});

	it('asks on navy vs black at the observed ~0.166 color distance', () => {
		const black = rgbaToColorSignature(flatRgba(22, 22, 24));
		const navy = rgbaToColorSignature(flatRgba(40, 45, 70));
		expect(isDarkNeutral(navy)).toBe(true);
		expect(isDarkNeutralPair(black, navy)).toBe(true);
		expect(identityColorFullPenalty(black, navy)).toBe(COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL);
		// Smoke: cos≈0.984, color_d≈0.166 → must clear ask floor with dark ramp.
		expect(identityScore(0.984, 0.166, identityColorFullPenalty(black, navy))).toBeGreaterThanOrEqual(0.5);
	});

	it('still separates near-black from olive with the hard floor', () => {
		const black = rgbaToColorSignature(flatRgba(22, 22, 24));
		const olive = rgbaToColorSignature(flatRgba(112, 128, 64));
		expect(isDarkNeutral(olive)).toBe(false);
		expect(isDarkNeutralPair(black, olive)).toBe(false);
		expect(cropColorDistance(black, olive)).toBeGreaterThanOrEqual(0.45);
	});

	it('decodes a 1×1 PNG', async () => {
		const png = Uint8Array.from(
			atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
			(c) => c.charCodeAt(0)
		);
		const rgba = await decodePngRgba(png.buffer);
		expect(rgba.length).toBe(4);
		expect(rgba[3]).toBe(255);
	});
});

function mixRgba(parts: Array<{ r: number; g: number; b: number; n: number }>): Uint8Array {
	const count = parts.reduce((sum, part) => sum + part.n, 0);
	const pixels = new Uint8Array(count * 4);
	let offset = 0;
	for (const part of parts) {
		for (let i = 0; i < part.n; i++) {
			pixels.set([part.r, part.g, part.b, 255], offset);
			offset += 4;
		}
	}
	return pixels;
}

function flatRgba(r: number, g: number, b: number): Uint8Array {
	const pixels = new Uint8Array(16);
	for (let i = 0; i < 4; i++) {
		pixels.set([r, g, b, 255], i * 4);
	}
	return pixels;
}
