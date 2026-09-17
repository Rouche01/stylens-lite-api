import { describe, expect, it } from 'vitest';
import { isClosetBrowseItem } from '../src/utils/closet_browse';

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
		expect(isClosetBrowseItem({ category: 'accessory', subcategory: 'eyewear' })).toBe(false);
	});
});
