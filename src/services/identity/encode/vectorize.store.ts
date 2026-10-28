import { IdentityEmbedError, VECTORIZE_INDEX_DIMENSIONS, IDENTITY_ENCODER } from './embed.types';
import { requireIdentitySlot, isIdentitySlot, type IdentitySlot } from './slot';

export type ClosetItemVectorMetadata = {
	user_id: string;
	slot: IdentitySlot;
	encoder: string;
	category: string;
	closet_item_id: string;
	color_h?: number;
	color_s?: number;
	color_l?: number;
};

export type ClosetVectorMatch = {
	id: string;
	score: number;
	closet_item_id: string;
	metadata?: ClosetItemVectorMetadata;
};

export type ClosetVectorUpsertResult = {
	ids: string[];
	count: number;
	mutationId?: string;
};

const VECTOR_ID_MAX_BYTES = 64;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 20;
/** Eval reset sweep: pull as many filtered neighbors as Vectorize allows per round. */
const USER_DELETE_TOP_K = 100;
const USER_DELETE_MAX_ROUNDS = 50;

export type DeleteByUserIdResult = {
	deleted: number;
	failed: number;
	rounds: number;
};

/** Unit-ish probe for metadata-filtered sweeps (direction does not matter under a tight user filter). */
export function randomUnitEmbedding(dimensions = VECTORIZE_INDEX_DIMENSIONS): number[] {
	const values = Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
	const norm = Math.sqrt(values.reduce((sum, n) => sum + n * n, 0));
	if (!Number.isFinite(norm) || norm === 0) {
		values[0] = 1;
		return values;
	}
	return values.map((n) => n / norm);
}

export function closetItemVectorId(closetItemId: string): string {
	const trimmed = closetItemId.trim();
	if (!trimmed) {
		throw new IdentityEmbedError('closetItemId is required', 400);
	}
	return assertVectorIdLength(`item:${trimmed}`);
}

export function assertVectorIdLength(id: string): string {
	if (new TextEncoder().encode(id).length > VECTOR_ID_MAX_BYTES) {
		throw new IdentityEmbedError(`Vector id exceeds Vectorize ${VECTOR_ID_MAX_BYTES}-byte limit`, 400);
	}
	return id;
}

export function resolveClosetVectorId(params: { id?: string; closetItemId?: string }): string {
	const explicit = params.id?.trim();
	if (explicit) {
		return assertVectorIdLength(explicit);
	}
	const closetItemId = params.closetItemId?.trim();
	if (closetItemId) {
		return closetItemVectorId(closetItemId);
	}
	return `scratch:${crypto.randomUUID()}`;
}

export function closetItemIdFromVectorId(vectorId: string, closetItemId?: string): string {
	const explicit = closetItemId?.trim();
	if (explicit) {
		return explicit;
	}
	if (vectorId.startsWith('item:')) {
		return vectorId.slice('item:'.length);
	}
	return vectorId;
}

export function normalizeCategory(category: string): string {
	const trimmed = category.trim().toLowerCase();
	if (!trimmed) {
		throw new IdentityEmbedError('category is required', 400);
	}
	return trimmed;
}

export function buildClosetVectorMetadata(params: {
	userId: string;
	category: string;
	closetItemId: string;
	color?: { color_h: number; color_s: number; color_l: number };
}): ClosetItemVectorMetadata {
	const userId = params.userId.trim();
	if (!userId) {
		throw new IdentityEmbedError('userId is required', 400);
	}
	const closetItemId = params.closetItemId.trim();
	if (!closetItemId) {
		throw new IdentityEmbedError('closet_item_id is required', 400);
	}
	const slot = requireIdentitySlot(params.category);
	return {
		user_id: userId,
		slot,
		encoder: IDENTITY_ENCODER,
		category: normalizeCategory(params.category),
		closet_item_id: closetItemId,
		...(params.color ?? {}),
	};
}

export function assertEmbeddingDimensions(values: number[]): void {
	if (values.length !== VECTORIZE_INDEX_DIMENSIONS) {
		throw new IdentityEmbedError(
			`Embedding length ${values.length} does not match Vectorize index ${VECTORIZE_INDEX_DIMENSIONS}`,
			500
		);
	}
}

export function buildClosetQueryFilter(params: {
	userId?: string;
	slot?: IdentitySlot;
	encoder?: string;
}): VectorizeVectorMetadataFilter | undefined {
	const filter: VectorizeVectorMetadataFilter = {};
	const userId = params.userId?.trim();
	if (userId) {
		filter.user_id = userId;
	}
	if (params.slot) {
		filter.slot = params.slot;
	}
	const encoder = params.encoder?.trim();
	if (encoder) {
		filter.encoder = encoder;
	}
	return Object.keys(filter).length ? filter : undefined;
}

export function clampTopK(topK?: number): number {
	if (topK == null || !Number.isFinite(topK)) {
		return DEFAULT_TOP_K;
	}
	return Math.min(MAX_TOP_K, Math.max(1, Math.floor(topK)));
}

function mutationIdOf(result: VectorizeVectorMutation | VectorizeAsyncMutation): string | undefined {
	if ('mutationId' in result && typeof result.mutationId === 'string' && result.mutationId) {
		return result.mutationId;
	}
	return undefined;
}

function normalizeMutation(result: VectorizeVectorMutation | VectorizeAsyncMutation): ClosetVectorUpsertResult {
	if ('ids' in result) {
		return { ids: result.ids, count: result.count, mutationId: mutationIdOf(result) };
	}
	return { ids: [], count: 0, mutationId: result.mutationId };
}

function optionalNumber(value: VectorizeVectorMetadata | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseMatchMetadata(metadata?: Record<string, VectorizeVectorMetadata>): ClosetItemVectorMetadata | undefined {
	if (!metadata) {
		return undefined;
	}
	const user_id = typeof metadata.user_id === 'string' ? metadata.user_id : '';
	const category = typeof metadata.category === 'string' ? metadata.category : '';
	const slot = typeof metadata.slot === 'string' && isIdentitySlot(metadata.slot) ? metadata.slot : undefined;
	const encoder = typeof metadata.encoder === 'string' ? metadata.encoder : '';
	const closet_item_id = typeof metadata.closet_item_id === 'string' ? metadata.closet_item_id : '';
	const color_h = optionalNumber(metadata.color_h);
	const color_s = optionalNumber(metadata.color_s);
	const color_l = optionalNumber(metadata.color_l);
	if (!user_id && !category && !closet_item_id && !slot) {
		return undefined;
	}
	return {
		user_id,
		slot: slot ?? 'upper',
		encoder: encoder || IDENTITY_ENCODER,
		category,
		closet_item_id,
		...(color_h != null ? { color_h } : {}),
		...(color_s != null ? { color_s } : {}),
		...(color_l != null ? { color_l } : {}),
	};
}

export class ClosetVectorStore {
	constructor(private index: VectorizeIndex) {}

	async upsert(id: string, values: number[], metadata: ClosetItemVectorMetadata): Promise<ClosetVectorUpsertResult> {
		assertEmbeddingDimensions(values);
		assertVectorIdLength(id);
		const result = await this.index.upsert([{ id, values, metadata }]);
		return normalizeMutation(result);
	}

	async getByIds(ids: string[]): Promise<VectorizeVector[]> {
		return this.index.getByIds(ids);
	}

	async deleteByIds(ids: string[]): Promise<ClosetVectorUpsertResult> {
		const result = await this.index.deleteByIds(ids);
		return normalizeMutation(result);
	}

	/**
	 * Delete every vector tagged with `user_id` (eval cycle wipe).
	 * Loops query+delete so orphans not listed in D1 are removed too.
	 */
	async deleteByUserId(
		userId: string,
		options: { topK?: number; maxRounds?: number } = {}
	): Promise<DeleteByUserIdResult> {
		const trimmed = userId.trim();
		if (!trimmed) {
			throw new IdentityEmbedError('userId is required', 400);
		}
		const topK = Math.min(USER_DELETE_TOP_K, Math.max(1, Math.floor(options.topK ?? USER_DELETE_TOP_K)));
		const maxRounds = Math.max(1, Math.floor(options.maxRounds ?? USER_DELETE_MAX_ROUNDS));
		const filter = buildClosetQueryFilter({ userId: trimmed });
		let deleted = 0;
		let failed = 0;
		let rounds = 0;

		for (let round = 0; round < maxRounds; round++) {
			const result = await this.index.query(randomUnitEmbedding(), {
				topK,
				returnMetadata: 'none',
				filter,
			});
			const ids = [...new Set((result.matches || []).map((match) => match.id).filter(Boolean))];
			if (ids.length === 0) {
				rounds = round;
				break;
			}
			rounds = round + 1;
			try {
				const mutation = await this.deleteByIds(ids);
				deleted += mutation.count || ids.length;
			} catch {
				failed += ids.length;
				break;
			}
			if (ids.length < topK) {
				break;
			}
		}

		return { deleted, failed, rounds };
	}

	async querySimilar(
		values: number[],
		options: { topK?: number; userId?: string; slot?: IdentitySlot; encoder?: string } = {}
	): Promise<{ matches: ClosetVectorMatch[]; count: number }> {
		assertEmbeddingDimensions(values);
		const result = await this.index.query(values, {
			topK: clampTopK(options.topK),
			returnMetadata: 'all',
			filter: buildClosetQueryFilter(options),
		});
		return {
			count: result.count,
			matches: result.matches.map((match) => {
				const metadata = parseMatchMetadata(match.metadata);
				return {
					id: match.id,
					score: match.score,
					closet_item_id: metadata?.closet_item_id || closetItemIdFromVectorId(match.id),
					metadata,
				};
			}),
		};
	}
}
