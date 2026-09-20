import type { ClosetMatchProbeEmbed } from '../../../db/closet';
import { cropColorDistance, identityScore } from '../encode/cropColor';
import type { PreparedClosetCrop, QueryClosetCropMatch } from '../encode/cropEncoder';
import { closetItemVectorId } from '../encode/vectorize.store';
import { resolveIdentitySlot } from '../encode/slot';
import { IDENTITY_ENCODER, VECTORIZE_INDEX_DIMENSIONS } from '../encode/embed.types';

export const UNINDEXED_PROBE_LIMIT = 25;
export const UNINDEXED_PROBE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type UnindexedClosetProbe = {
	closetItemId: string;
	category: string;
	label: string;
	probeEmbed: ClosetMatchProbeEmbed;
};

/** Dot product; vectors from the identity embedder are L2-normalized. */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += (a[i] ?? 0) * (b[i] ?? 0);
	}
	return dot;
}

export function scoreUnindexedProbes(params: {
	prepared: PreparedClosetCrop;
	probes: readonly UnindexedClosetProbe[];
	category?: string;
}): QueryClosetCropMatch[] {
	const probeSlot = resolveIdentitySlot(params.category);
	const matches: QueryClosetCropMatch[] = [];

	for (const row of params.probes) {
		if (probeSlot) {
			const rowSlot = resolveIdentitySlot(row.category);
			if (rowSlot && rowSlot !== probeSlot) continue;
		}
		const embed = row.probeEmbed;
		if (embed.encoder !== IDENTITY_ENCODER) continue;
		if (embed.dimensions !== VECTORIZE_INDEX_DIMENSIONS) continue;
		if (embed.vector.length !== embed.dimensions) continue;
		if (embed.vector.length !== params.prepared.vector.length) continue;

		const cosine = cosineSimilarity(params.prepared.vector, embed.vector);
		const colorDistance =
			params.prepared.crop_color && embed.crop_color
				? cropColorDistance(params.prepared.crop_color, embed.crop_color)
				: null;
		matches.push({
			id: closetItemVectorId(row.closetItemId),
			score: cosine,
			closet_item_id: row.closetItemId,
			d1_closet_item_id: row.closetItemId,
			d1_label: row.label,
			color_distance: colorDistance,
			identity_score: identityScore(cosine, colorDistance),
		});
	}

	return matches.sort((a, b) => b.identity_score - a.identity_score);
}

/** Prefer higher identity_score when the same closet item appears in ANN and local probes. */
export function mergeIdentityNeighbors(
	annNeighbors: readonly QueryClosetCropMatch[],
	localNeighbors: readonly QueryClosetCropMatch[]
): QueryClosetCropMatch[] {
	const byKey = new Map<string, QueryClosetCropMatch>();
	const keyOf = (match: QueryClosetCropMatch) =>
		match.d1_closet_item_id?.trim() || match.closet_item_id?.trim() || match.id;

	for (const match of [...annNeighbors, ...localNeighbors]) {
		const key = keyOf(match);
		const existing = byKey.get(key);
		if (!existing || match.identity_score > existing.identity_score) {
			byKey.set(key, match);
		}
	}

	return [...byKey.values()].sort((a, b) => b.identity_score - a.identity_score);
}
