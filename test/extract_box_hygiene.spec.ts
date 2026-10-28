import { describe, it, expect } from 'vitest';
import {
	extractBoxAreaPercent,
	extractItemKeepScore,
	isPlausibleExtractBox,
	sanitizeExtractedItems,
} from '../src/utils/extract_box_hygiene';

describe('isPlausibleExtractBox', () => {
	it('rejects torso-tall under-layer boxes from smoke', () => {
		expect(
			isPlausibleExtractBox({
				category: 'top',
				subcategory: 'shirt',
				bounding_box: { x: 21.8, y: 34.8, width: 30.4, height: 64.8 },
			})
		).toBe(false);
	});

	it('keeps normal jacket and hoodie boxes', () => {
		expect(
			isPlausibleExtractBox({
				category: 'outerwear',
				subcategory: 'jacket',
				bounding_box: { x: 22.2, y: 50.8, width: 23.3, height: 18.3 },
			})
		).toBe(true);
		expect(
			isPlausibleExtractBox({
				category: 'top',
				subcategory: 'hoodie',
				bounding_box: { x: 26.9, y: 33.4, width: 43, height: 26.3 },
			})
		).toBe(true);
	});
});

describe('sanitizeExtractedItems', () => {
	it('keeps outerwear over a duplicate sweater crop', () => {
		const box = { x: 22.2, y: 50.8, width: 23.3, height: 18.3 };
		const items = sanitizeExtractedItems([
			{
				label: 'grey ribbed sweater',
				category: 'top',
				subcategory: 'sweater',
				confidence: 'high',
				bounding_box: box,
			},
			{
				label: 'black leather jacket',
				category: 'outerwear',
				subcategory: 'jacket',
				confidence: 'high',
				bounding_box: { ...box },
			},
		]);
		expect(items.map((item) => item.label)).toEqual(['black leather jacket']);
	});

	it('keeps footwear over socks on the same foot crop', () => {
		const box = { x: 33.7, y: 84.4, width: 7.7, height: 5.2 };
		const items = sanitizeExtractedItems([
			{
				label: 'white socks',
				category: 'accessory',
				subcategory: 'socks',
				confidence: 'high',
				bounding_box: box,
			},
			{
				label: 'white sneakers',
				category: 'footwear',
				subcategory: 'sneakers',
				confidence: 'high',
				bounding_box: { ...box },
			},
		]);
		expect(items.map((item) => item.label)).toEqual(['white sneakers']);
	});

	it('preserves distinct garments with low overlap', () => {
		const items = sanitizeExtractedItems([
			{
				label: 'black baseball cap',
				category: 'accessory',
				subcategory: 'hat',
				confidence: 'high',
				bounding_box: { x: 32.5, y: 45.1, width: 6.6, height: 3.2 },
			},
			{
				label: 'black leather jacket',
				category: 'outerwear',
				subcategory: 'jacket',
				confidence: 'high',
				bounding_box: { x: 22.2, y: 50.8, width: 23.3, height: 18.3 },
			},
			{
				label: 'light blue jeans',
				category: 'bottom',
				subcategory: 'jeans',
				confidence: 'high',
				bounding_box: { x: 25, y: 65.7, width: 16, height: 22.9 },
			},
		]);
		expect(items).toHaveLength(3);
	});
});

describe('extract helpers', () => {
	it('scores outerwear above top on the same crop', () => {
		const box = { x: 10, y: 10, width: 20, height: 20 };
		expect(
			extractItemKeepScore({ category: 'outerwear', confidence: 'high', bounding_box: box })
		).toBeGreaterThan(extractItemKeepScore({ category: 'top', confidence: 'high', bounding_box: box }));
	});

	it('computes frame area percent', () => {
		expect(extractBoxAreaPercent({ x: 0, y: 0, width: 50, height: 40 })).toBe(20);
	});
});
