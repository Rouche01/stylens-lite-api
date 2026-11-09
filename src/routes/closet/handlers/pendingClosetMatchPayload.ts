import type { ClosetItemDetails, ClosetItemMatchWithOutfit } from '../../../db/closet';

export type PendingClosetMatchClientPayload = {
	id: string;
	outfit_id: string;
	score: number;
	cosine: number | null;
	color_distance: number | null;
	created_at: number;
	probe: {
		label: string;
		category: string;
		subcategory: string;
		color: string;
		pattern: string;
		image_key: string;
		bounding_box: ClosetItemMatchWithOutfit['bounding_box'];
		original_image_url?: string;
		isolated_image_url?: string;
	};
	candidate: {
		closet_item_id: string;
		label: string;
		category: string;
		subcategory: string;
		color: string;
		bounding_box: ClosetItemDetails['bounding_box'];
		original_image_url?: string;
		isolated_image_url?: string;
	};
};

/** Flutter pending JSON. Never include probe_embed or the 1024-float vector. */
export function pendingClosetMatchClientPayload(
	match: ClosetItemMatchWithOutfit,
	params: {
		probeOriginalUrl?: string;
		probeIsolatedUrl?: string;
		candidateDetails: ClosetItemDetails | null;
		candidateOriginalUrl?: string;
		candidateIsolatedUrl?: string;
	}
): PendingClosetMatchClientPayload {
	const snapshot = match.extract_snapshot;
	return {
		id: match.id,
		outfit_id: match.outfit_id,
		score: match.score,
		cosine: match.cosine,
		color_distance: match.color_distance,
		created_at: match.created_at,
		probe: {
			label: snapshot.label,
			category: snapshot.category,
			subcategory: snapshot.subcategory,
			color: snapshot.color,
			pattern: snapshot.pattern,
			image_key: match.outfit_image_key,
			bounding_box: match.bounding_box,
			original_image_url: params.probeOriginalUrl,
			isolated_image_url: params.probeIsolatedUrl,
		},
		candidate: {
			closet_item_id: match.candidate_closet_item_id,
			label: params.candidateDetails?.label ?? snapshot.label,
			category: params.candidateDetails?.category ?? snapshot.category,
			subcategory: params.candidateDetails?.subcategory ?? snapshot.subcategory,
			color: params.candidateDetails?.color ?? snapshot.color,
			bounding_box: params.candidateDetails?.bounding_box,
			original_image_url: params.candidateOriginalUrl,
			isolated_image_url: params.candidateIsolatedUrl,
		},
	};
}
