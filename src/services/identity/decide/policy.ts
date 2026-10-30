import { ClothingItem, ExtractionConfidence } from '../../../types';
import { identityEmbedBox } from '../../../utils/bounding_box';
import { isIdentityMatch } from '../encode/cropColor';
import type { QueryClosetCropMatch } from '../encode/cropEncoder';
import { resolveIdentitySlot, type IdentitySlot } from '../encode/slot';
import { closetItemVectorId } from '../encode/vectorize.store';

/** Slots where hat≠socks / sneakers≠boots — Claude subcategory is reliable enough to hard-gate asks. */
const SUBCATEGORY_STRICT_SLOTS: ReadonlySet<IdentitySlot> = new Set(['accessory', 'footwear']);

/** Closed shoes: soft-compatible (×{@link SUBCATEGORY_FAMILY_PENALTY}); open vs closed stays hard-blocked. */
const CLOSED_SHOE_SUBCATEGORIES: ReadonlySet<string> = new Set(['boots', 'sneakers', 'loafers']);

/** Multiplicative score penalty when subcategory differs but shares a soft family. */
export const SUBCATEGORY_FAMILY_PENALTY = 0.85;

export type IdentityProbeHints = {
	category?: string | null;
	subcategory?: string | null;
};

export type IdentitySubcategoryRelation = 'exact' | 'family' | 'reject' | 'open';

export function normalizeIdentitySubcategory(value?: string | null): string | null {
	const key = value?.trim().toLowerCase();
	return key || null;
}

function closedShoeFamily(sub: string): boolean {
	return CLOSED_SHOE_SUBCATEGORIES.has(sub);
}

/**
 * How probe vs neighbor subcategory relate for identity gating.
 * - exact / open → keep score
 * - family → allow with {@link SUBCATEGORY_FAMILY_PENALTY}
 * - reject → drop neighbor (hat≠socks; boots≠sandals)
 */
export function identitySubcategoryRelation(
	probeSubcategory?: string | null,
	neighborSubcategory?: string | null,
	slot?: IdentitySlot | null
): IdentitySubcategoryRelation {
	if (!slot || !SUBCATEGORY_STRICT_SLOTS.has(slot)) return 'open';
	const probe = normalizeIdentitySubcategory(probeSubcategory);
	const neighbor = normalizeIdentitySubcategory(neighborSubcategory);
	if (!probe || !neighbor) return 'open';
	if (probe === neighbor) return 'exact';
	if (slot === 'footwear' && closedShoeFamily(probe) && closedShoeFamily(neighbor)) {
		return 'family';
	}
	return 'reject';
}

/**
 * Within accessory/footwear, reject cross-subcategory neighbors (cap must not ask vs socks).
 * Closed shoes (boots/sneakers/loafers) are soft-compatible. Upper/lower stay open (Claude swaps).
 */
export function identitySubcategoryCompatible(
	probeSubcategory?: string | null,
	neighborSubcategory?: string | null,
	slot?: IdentitySlot | null
): boolean {
	return identitySubcategoryRelation(probeSubcategory, neighborSubcategory, slot) !== 'reject';
}

export function neighborsCompatibleWithProbe(
	neighbors: readonly QueryClosetCropMatch[],
	hints?: IdentityProbeHints
): QueryClosetCropMatch[] {
	const slot = resolveIdentitySlot(hints?.category ?? undefined) ?? null;
	const probeSub = hints?.subcategory;
	const out: QueryClosetCropMatch[] = [];
	for (const match of neighbors) {
		const relation = identitySubcategoryRelation(probeSub, match.d1_subcategory, slot);
		if (relation === 'reject') continue;
		if (relation === 'family') {
			out.push({
				...match,
				identity_score: match.identity_score * SUBCATEGORY_FAMILY_PENALTY,
			});
			continue;
		}
		out.push(match);
	}
	return out.sort((a, b) => b.identity_score - a.identity_score);
}

/**
 * One row per closet item — keep the wear with the highest identity_score.
 * Multiple Vectorize vectors can share `closet_item_id` after confirmed-same prototypes.
 */
export function collapseNeighborsByClosetItem(
	neighbors: readonly QueryClosetCropMatch[]
): QueryClosetCropMatch[] {
	const best = new Map<string, QueryClosetCropMatch>();
	for (const match of neighbors) {
		const key = candidateClosetItemId(match) || match.id;
		const prev = best.get(key);
		if (!prev || match.identity_score > prev.identity_score) {
			best.set(key, match);
		}
	}
	return [...best.values()].sort((a, b) => b.identity_score - a.identity_score);
}

export type IdentityCreateReason =
	| 'skip_query'
	| 'no_neighbor'
	| 'below_threshold'
	| 'identity_error'
	| 'missing_candidate'
	| 'upsert_failed'
	| 'embed_failed'
	| 'visibility_timeout'
	| 'd1_failed'
	| 'race_lost'
	| 'existing_crop';

export type IdentityDecision =
	| {
			action: 'create';
			reason: IdentityCreateReason;
			identityScore?: number | null;
			/** Nearest neighbor declined for ask (below_threshold / missing_candidate). */
			neighborClosetItemId?: string | null;
			cosine?: number | null;
			colorDistance?: number | null;
	  }
	| {
			action: 'ask';
			candidateClosetItemId: string;
			identityScore: number;
			cosine: number;
			colorDistance: number | null;
	  };

export type CommitDecision =
	| { action: 'commit' }
	| {
			action: 'ask';
			candidateClosetItemId: string;
			identityScore: number;
			cosine: number;
			colorDistance: number | null;
	  }
	| {
			action: 'yield';
			winnerId: string;
			identityScore: number;
			cosine: number;
			colorDistance: number | null;
	  };

export function candidateClosetItemId(match: QueryClosetCropMatch | undefined): string | null {
	if (!match) return null;
	const d1 = match.d1_closet_item_id?.trim();
	if (d1) return d1;
	const meta = match.closet_item_id?.trim();
	if (meta && !meta.startsWith('scratch:')) return meta;
	return null;
}

export function neighborsExcludingSelf(
	neighbors: QueryClosetCropMatch[],
	selfClosetItemId: string
): QueryClosetCropMatch[] {
	const selfVectorId = closetItemVectorId(selfClosetItemId);
	return neighbors.filter(
		(match) => match.id !== selfVectorId && match.closet_item_id !== selfClosetItemId
	);
}

export function decideIdentityFromNeighbors(
	neighbors: QueryClosetCropMatch[],
	hints?: IdentityProbeHints
): IdentityDecision {
	const collapsed = collapseNeighborsByClosetItem(neighbors);
	const compatible = neighborsCompatibleWithProbe(collapsed, hints);
	const top = compatible[0] ?? collapsed[0];
	if (!compatible[0]) {
		if (!collapsed[0]) {
			return { action: 'create', reason: 'no_neighbor' };
		}
		// Wrong-subcategory ANN hit (e.g. hat→socks): create, keep score breadcrumbs.
		return {
			action: 'create',
			reason: 'below_threshold',
			identityScore: collapsed[0].identity_score,
			neighborClosetItemId: candidateClosetItemId(collapsed[0]),
			cosine: collapsed[0].score,
			colorDistance: collapsed[0].color_distance,
		};
	}
	// Meta-only ids are fine for eval breadcrumbs; asks require a live D1 row
	// (orphan Vectorize hits after eval reset must not createPendingMatch → FK).
	const neighborId = candidateClosetItemId(top);
	const d1Candidate = top.d1_closet_item_id?.trim() || null;
	if (!isIdentityMatch(top.identity_score)) {
		return {
			action: 'create',
			reason: 'below_threshold',
			identityScore: top.identity_score,
			neighborClosetItemId: neighborId,
			cosine: top.score,
			colorDistance: top.color_distance,
		};
	}
	if (!d1Candidate) {
		return {
			action: 'create',
			reason: 'missing_candidate',
			identityScore: top.identity_score,
			neighborClosetItemId: neighborId,
			cosine: top.score,
			colorDistance: top.color_distance,
		};
	}
	return {
		action: 'ask',
		candidateClosetItemId: d1Candidate,
		identityScore: top.identity_score,
		cosine: top.score,
		colorDistance: top.color_distance,
	};
}

export function decideCommitAfterRequery(
	selfClosetItemId: string,
	neighbors: QueryClosetCropMatch[],
	ignoreClosetItemIds: readonly string[] = [],
	hints?: IdentityProbeHints
): CommitDecision {
	const ignored = new Set(ignoreClosetItemIds);
	const contenders = neighborsCompatibleWithProbe(
		neighborsExcludingSelf(collapseNeighborsByClosetItem(neighbors), selfClosetItemId),
		hints
	).filter((match) => {
		if (!isIdentityMatch(match.identity_score)) return false;
		const candidateId = candidateClosetItemId(match);
		if (candidateId && ignored.has(candidateId)) return false;
		if (match.closet_item_id && ignored.has(match.closet_item_id)) return false;
		return true;
	});
	if (contenders.length === 0) {
		return { action: 'commit' };
	}

	const committed = contenders
		.filter((match) => match.d1_closet_item_id)
		.sort((a, b) => b.identity_score - a.identity_score);
	if (committed[0]?.d1_closet_item_id) {
		return {
			action: 'ask',
			candidateClosetItemId: committed[0].d1_closet_item_id,
			identityScore: committed[0].identity_score,
			cosine: committed[0].score,
			colorDistance: committed[0].color_distance,
		};
	}

	const rivalIds = contenders
		.map((match) => match.closet_item_id?.trim())
		.filter((id): id is string => Boolean(id) && !id.startsWith('scratch:'));
	const winnerId = [selfClosetItemId, ...rivalIds].sort()[0];
	if (winnerId === selfClosetItemId) {
		return { action: 'commit' };
	}
	const rival = contenders.find((match) => match.closet_item_id === winnerId) ?? contenders[0];
	return {
		action: 'yield',
		winnerId,
		identityScore: rival.identity_score,
		cosine: rival.score,
		colorDistance: rival.color_distance,
	};
}

export function shouldQueryIdentity(item: ClothingItem): boolean {
	if (item.confidence === ExtractionConfidence.LOW) {
		return false;
	}
	return (
		identityEmbedBox(item.bounding_box, {
			category: item.category,
			subcategory: item.subcategory,
		}) !== null
	);
}
