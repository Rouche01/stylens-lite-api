import { describe, it, expect } from 'vitest';
import { parseJinaEmbedding } from '../src/services/identity/encode/providers/jina.provider';
import { parseDinoClsEmbedding, resolveDinoModel } from '../src/services/identity/encode/providers/replicate.provider';
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
	decodePngRgba,
} from '../src/services/identity/encode/cropColor';
import { resolveIdentitySlot } from '../src/services/identity/encode/slot';
import {
	assertEmbeddingDimensions,
	buildClosetQueryFilter,
	buildClosetVectorMetadata,
	clampTopK,
	closetItemVectorId,
	ClosetVectorStore,
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
		expect(distance).toBeGreaterThan(0.35);
		expect(identityScore(0.96, distance)).toBeLessThan(0.5);
	});

	it('rejects 0.96 cosine when crop color is as far as olive vs black zip', () => {
		expect(identityScore(0.96, 0.032)).toBeGreaterThan(0.5);
		expect(identityScore(0.96, 0.134)).toBeLessThan(0.5);
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
