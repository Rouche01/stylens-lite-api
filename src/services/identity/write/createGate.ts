import { ClothingItem, ExtractionConfidence } from '../../../types';
import { identityEmbedBox } from '../../../utils/bounding_box';
import type { IdentityCreateReason } from '../decide/policy';

export type ClosetCreateIgnoreReason = Extract<
	IdentityCreateReason,
	'ignored_unusable_box' | 'ignored_low_confidence'
>;

/**
 * Create-side populate gate (independent of SAM face quality).
 * When ignore=true: no D1 tile, no Vectorize, no ask — outfit photo stays.
 */
export function closetCreateIgnoreReason(
	item: ClothingItem,
	opts: { extractItemCount: number }
): ClosetCreateIgnoreReason | null {
	const box = item.bounding_box;
	if (
		!box ||
		!identityEmbedBox(box, {
			category: item.category,
			subcategory: item.subcategory,
		})
	) {
		return 'ignored_unusable_box';
	}

	// Soft skip: low confidence is safe to ignore when other pieces exist on the outfit.
	// Sole extract still creates (skip_query / no ANN) so a single fuzzy piece isn't dropped.
	if (item.confidence === ExtractionConfidence.LOW && opts.extractItemCount > 1) {
		return 'ignored_low_confidence';
	}

	return null;
}
