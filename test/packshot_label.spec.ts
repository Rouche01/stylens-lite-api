import { describe, expect, it } from 'vitest';
import { packshotTypeLabel } from '../src/services/closet_face';

describe('packshotTypeLabel', () => {
	it('prefers footwear subcategory over a boots-biased free-text label', () => {
		expect(
			packshotTypeLabel({
				label: 'black boots',
				category: 'footwear',
				subcategory: 'sneakers',
			})
		).toBe('sneakers');
	});

	it('uses boots subcategory when extract says boots', () => {
		expect(
			packshotTypeLabel({
				label: 'black leather boots',
				category: 'footwear',
				subcategory: 'boots',
			})
		).toBe('boots');
	});

	it('strips boot words when subcategory is missing (falls back to shoe if only a color left)', () => {
		expect(
			packshotTypeLabel({
				label: 'black chelsea boots',
				category: 'footwear',
				subcategory: null,
			})
		).toBe('shoe');
		expect(
			packshotTypeLabel({
				label: 'boots',
				category: 'footwear',
			})
		).toBe('shoe');
		expect(
			packshotTypeLabel({
				label: 'white leather sneakers',
				category: 'footwear',
				subcategory: null,
			})
		).toBe('white leather sneakers');
	});

	it('leaves non-footwear labels unchanged', () => {
		expect(
			packshotTypeLabel({
				label: 'black baseball cap',
				category: 'accessory',
				subcategory: 'hat',
			})
		).toBe('black baseball cap');
	});
});
