import { describe, it, expect } from 'vitest';
import {
	ClothingItemCategory,
	ClothingItemSubcategory,
	ExtractionConfidence,
} from '../src/types';
import { closetCreateIgnoreReason } from '../src/services/identity/write/createGate';

function item(overrides: Partial<Parameters<typeof closetCreateIgnoreReason>[0]> = {}) {
	return {
		label: 'test',
		category: ClothingItemCategory.TOP,
		subcategory: ClothingItemSubcategory.TSHIRT,
		color: 'black',
		pattern: 'solid' as const,
		style_tags: [],
		confidence: ExtractionConfidence.HIGH,
		bounding_box: { x: 10, y: 10, width: 30, height: 40 },
		...overrides,
	};
}

describe('closetCreateIgnoreReason', () => {
	it('ignores unusable tiny boxes', () => {
		expect(
			closetCreateIgnoreReason(
				item({
					category: ClothingItemCategory.ACCESSORY,
					subcategory: ClothingItemSubcategory.OTHER,
					bounding_box: { x: 32, y: 45, width: 6.6, height: 3.2 },
				}),
				{ extractItemCount: 1 }
			)
		).toBe('ignored_unusable_box');
	});

	it('ignores low confidence when other extract items exist', () => {
		expect(
			closetCreateIgnoreReason(item({ confidence: ExtractionConfidence.LOW }), {
				extractItemCount: 3,
			})
		).toBe('ignored_low_confidence');
	});

	it('allows low confidence when it is the sole extract item', () => {
		expect(
			closetCreateIgnoreReason(item({ confidence: ExtractionConfidence.LOW }), {
				extractItemCount: 1,
			})
		).toBeNull();
	});

	it('allows a usable high-confidence crop', () => {
		expect(closetCreateIgnoreReason(item(), { extractItemCount: 2 })).toBeNull();
	});
});
