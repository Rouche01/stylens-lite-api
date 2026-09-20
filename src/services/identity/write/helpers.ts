import type { ClosetItemExtractSnapshot, ClosetItemMatchWithOutfit } from '../../../db/closet';
import {
	ClothingItem,
	ClothingItemCategory,
	ClothingItemPattern,
	ClothingItemSubcategory,
	ExtractionConfidence,
} from '../../../types';
import type { ClosetCatalogNotifyItem } from '../../../utils/closet_browse';
import type { IdentityCreateReason } from '../decide/policy';
import type { ClosetVectorBackfillJob, ClosetVectorRepairJob } from '../jobs/closetVectorRepair';
import type { OutfitIdentityWriteDeps, ProcessedOutfitItem } from './types';

export function failedItem(
	item: ClothingItem,
	reason: IdentityCreateReason,
	identityScore?: number | null
): ProcessedOutfitItem {
	return {
		...item,
		closet_item_id: null,
		is_new_closet_item: false,
		identity_status: 'failed',
		identity_reason: reason,
		match_id: null,
		candidate_closet_item_id: null,
		identity_score: identityScore ?? null,
	};
}

export function clothingItemFromMatch(match: ClosetItemMatchWithOutfit): ClothingItem {
	return {
		label: match.extract_snapshot.label,
		category: (match.extract_snapshot.category as ClothingItemCategory) || ClothingItemCategory.ACCESSORY,
		subcategory:
			(match.extract_snapshot.subcategory as ClothingItemSubcategory) || ClothingItemSubcategory.OTHER,
		color: match.extract_snapshot.color,
		pattern: (match.extract_snapshot.pattern as ClothingItemPattern) || ClothingItemPattern.OTHER,
		style_tags: match.extract_snapshot.styleTags,
		confidence: (match.confidence as ExtractionConfidence) || ExtractionConfidence.MEDIUM,
		bounding_box: match.bounding_box,
	};
}

export function extractSnapshot(item: ClothingItem): ClosetItemExtractSnapshot {
	return {
		label: item.label,
		category: item.category,
		subcategory: item.subcategory,
		color: item.color,
		pattern: item.pattern,
		styleTags: item.style_tags || [],
	};
}

export function extractionConfidence(confidence: ClothingItem['confidence']): 'high' | 'medium' | 'low' {
	if (confidence === ExtractionConfidence.HIGH) return 'high';
	if (confidence === ExtractionConfidence.LOW) return 'low';
	return 'medium';
}

export async function enqueueVectorRepair(
	deps: OutfitIdentityWriteDeps,
	job: ClosetVectorRepairJob | ClosetVectorBackfillJob
): Promise<void> {
	if (!deps.repairQueue) return;
	try {
		await deps.repairQueue.send(job);
	} catch (err) {
		deps.log.warn(
			'closet_vector_repair_enqueue_failed',
			{
				closet_item_id: 'closetItemId' in job ? job.closetItemId : undefined,
				match_id: 'matchId' in job ? job.matchId : undefined,
			},
			err
		);
	}
}

export async function notifyCatalog(
	deps: OutfitIdentityWriteDeps,
	userId: string,
	outfitId: string,
	items: readonly ClosetCatalogNotifyItem[]
): Promise<void> {
	if (!deps.catalog) return;
	try {
		await deps.catalog.notify({ userId, outfitId, items });
	} catch (err) {
		deps.log.warn(
			'closet_catalog_broadcast_failed',
			{ user_id: userId, outfit_id: outfitId },
			err
		);
	}
}
