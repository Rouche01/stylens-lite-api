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
