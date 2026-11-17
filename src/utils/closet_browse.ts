import { ClothingItemCategory } from 'types';

/**
 * Accessory subcategories omitted from GET /closet/items.
 * They stay in the DB for identity. Headphones/phones land as `other`.
 */
const CLOSET_BROWSE_EXCLUDED_ACCESSORIES = new Set([
	'socks',
	'gloves',
	'jewelry',
	'watch',
	'belt',
	// 'eyewear',
	'other',
]);

export function isClosetBrowseItem(item: { category: string; subcategory?: string | null }): boolean {
	if (item.category !== ClothingItemCategory.ACCESSORY) {
		return true;
	}
	return !CLOSET_BROWSE_EXCLUDED_ACCESSORIES.has((item.subcategory || '').trim().toLowerCase());
}

export type ClosetCatalogNotifyItem = {
	closet_item_id: string | null;
	identity_status: 'created' | 'ask' | 'failed';
	category: string;
	subcategory?: string | null;
};

/** Browse-visible closet ids that should trigger a catalog ping. Empty → do not broadcast. */
export function closetCatalogNotifyFromProcessedItems(
	items: readonly ClosetCatalogNotifyItem[]
): { closet_item_ids: string[] } {
	const closet_item_ids: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (item.identity_status !== 'created') continue;
		const id = item.closet_item_id?.trim();
		if (!id || seen.has(id)) continue;
		if (!isClosetBrowseItem(item)) continue;
		seen.add(id);
		closet_item_ids.push(id);
	}
	return { closet_item_ids };
}
