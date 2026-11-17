import { describe, expect, it } from 'vitest';
import { closetCatalogNotifyFromProcessedItems, isClosetBrowseItem } from '../src/utils/closet_browse';

describe('isClosetBrowseItem', () => {
	it('keeps garments and outfit-visible accessories', () => {
		expect(isClosetBrowseItem({ category: 'top', subcategory: 't-shirt' })).toBe(true);
		expect(isClosetBrowseItem({ category: 'footwear', subcategory: 'sneakers' })).toBe(true);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'bag' })).toBe(true);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'hat' })).toBe(true);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'scarf' })).toBe(true);
	});

	it('hides clutter accessories such as socks and headphones', () => {
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'socks' })).toBe(false);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'gloves' })).toBe(false);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'other' })).toBe(false);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'watch' })).toBe(false);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'jewelry' })).toBe(false);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'belt' })).toBe(false);
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'eyewear' })).toBe(true);
	});
});

describe('closetCatalogNotifyFromProcessedItems', () => {
	it('keeps created browse ids and drops ask, failed, and excluded accessories', () => {
		expect(
			closetCatalogNotifyFromProcessedItems([
				{ closet_item_id: 'top-1', identity_status: 'created', category: 'top', subcategory: 't-shirt' },
				{ closet_item_id: 'ask-1', identity_status: 'ask', category: 'top', subcategory: 'shirt' },
				{ closet_item_id: 'fail-1', identity_status: 'failed', category: 'bottom', subcategory: 'jeans' },
				{ closet_item_id: 'socks-1', identity_status: 'created', category: 'accessory', subcategory: 'socks' },
			])
		).toEqual({ closet_item_ids: ['top-1'] });
	});

	it('from a mixed photo returns only the browse-visible created ids', () => {
		expect(
			closetCatalogNotifyFromProcessedItems([
				{ closet_item_id: 'shirt-1', identity_status: 'created', category: 'top', subcategory: 'shirt' },
				{ closet_item_id: 'bag-1', identity_status: 'created', category: 'accessory', subcategory: 'bag' },
				{ closet_item_id: 'socks-1', identity_status: 'created', category: 'accessory', subcategory: 'socks' },
				{ closet_item_id: null, identity_status: 'ask', category: 'top', subcategory: 'sweater' },
			])
		).toEqual({ closet_item_ids: ['shirt-1', 'bag-1'] });
	});

	it('dedupes the same closet item id', () => {
		expect(
			closetCatalogNotifyFromProcessedItems([
				{ closet_item_id: 'c1', identity_status: 'created', category: 'top', subcategory: 'shirt' },
				{ closet_item_id: 'c1', identity_status: 'created', category: 'top', subcategory: 'shirt' },
			])
		).toEqual({ closet_item_ids: ['c1'] });
	});
});
