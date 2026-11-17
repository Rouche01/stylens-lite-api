import type { QueryClosetCropMatch } from '../encode/cropEncoder';
import type { PreparedClosetCrop } from '../encode/cropEncoder';
import { scoreUnindexedProbes, type UnindexedClosetProbe } from './unindexedFallback';
import type { IdentityDecision } from './policy';

/** Min identity_score for an ask/link to count toward detecting a prior outfit. */
export const OUTFIT_PRIOR_HIT_MIN = 0.8;

/** Relaxed ask floor when re-scoring against a detected prior outfit's tiles. */
export const OUTFIT_PRIOR_ASK_MIN = 0.4;

/** Need this many high-score hits pointing at the same prior outfit. */
export const OUTFIT_PRIOR_MIN_HITS = 2;

export type OutfitPriorHit = {
	candidateClosetItemId: string;
	identityScore: number;
};

/**
 * Pick a prior outfit that ≥ {@link OUTFIT_PRIOR_MIN_HITS} high-score candidates share.
 * `memberships` maps closet_item_id → outfit ids (excluding the current photo).
 */
export function selectPriorOutfitId(
	hits: readonly OutfitPriorHit[],
	memberships: ReadonlyMap<string, readonly string[]>
): string | null {
	const strong = hits.filter(
		(hit) =>
			Number.isFinite(hit.identityScore) &&
			hit.identityScore >= OUTFIT_PRIOR_HIT_MIN &&
			Boolean(hit.candidateClosetItemId.trim())
	);
	if (strong.length < OUTFIT_PRIOR_MIN_HITS) return null;

	const counts = new Map<string, number>();
	for (const hit of strong) {
		const outfits = memberships.get(hit.candidateClosetItemId) ?? [];
		for (const outfitId of new Set(outfits)) {
			const id = outfitId.trim();
			if (!id) continue;
			counts.set(id, (counts.get(id) ?? 0) + 1);
		}
	}

	let bestId: string | null = null;
	let bestCount = 0;
	for (const [outfitId, count] of counts) {
		if (count < OUTFIT_PRIOR_MIN_HITS) continue;
		if (count > bestCount) {
			bestCount = count;
			bestId = outfitId;
		}
	}
	return bestId;
}

/**
 * Creates eligible for outfit-prior rescue / deferred commit.
 * `no_neighbor` commits immediately so later crops in the same photo can match
 * an earlier unindexed create via the local probe fallback.
 */
export function isOutfitPriorRescueable(
	decision: Extract<IdentityDecision, { action: 'create' }>
): boolean {
	return decision.reason === 'below_threshold' || decision.reason === 'missing_candidate';
}

/**
 * Score a crop only against tiles from a prior outfit. Slot filter stays;
 * subcategory gate is bypassed. Always returns ask (never auto-link) when above the relaxed floor.
 */
export function decideOutfitPriorAsk(params: {
	prepared: PreparedClosetCrop;
	probes: readonly UnindexedClosetProbe[];
	category?: string;
}): Extract<IdentityDecision, { action: 'ask' }> | null {
	const neighbors = scoreUnindexedProbes({
		prepared: params.prepared,
		probes: params.probes,
		category: params.category,
		// omit subcategory → scoreUnindexedProbes still slot-filters only
	});
	const top = bestNeighbor(neighbors);
	const candidateId = top?.d1_closet_item_id?.trim();
	if (!top || !candidateId) return null;
	if (!(top.identity_score >= OUTFIT_PRIOR_ASK_MIN)) return null;
	return {
		action: 'ask',
		reason: 'outfit_prior',
		candidateClosetItemId: candidateId,
		identityScore: top.identity_score,
		cosine: top.score,
		colorDistance: top.color_distance,
	};
}

function bestNeighbor(neighbors: readonly QueryClosetCropMatch[]): QueryClosetCropMatch | undefined {
	return neighbors[0];
}
