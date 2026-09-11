import { describe, it, expect } from 'vitest';
import { normalizeOutfitBoundingBox } from '../src/utils/bounding_box';
import { outfitExtractionUserPrompt } from '../src/llm/prompts/outfit_extraction';

describe('normalizeOutfitBoundingBox', () => {
	it('keeps percent boxes and clamps overflow', () => {
		expect(normalizeOutfitBoundingBox({ x: 20, y: 25, width: 50, height: 45 }, 1350, 1800)).toEqual({
			x: 20,
			y: 25,
			width: 50,
			height: 45,
		});
		expect(normalizeOutfitBoundingBox({ x: 80, y: 10, width: 40, height: 10 }, 1000, 1000)).toEqual({
			x: 80,
			y: 10,
			width: 20,
			height: 10,
		});
	});

	it('converts pixel boxes when any side exceeds 100', () => {
		expect(normalizeOutfitBoundingBox({ x: 270, y: 450, width: 405, height: 540 }, 1350, 1800)).toEqual({
			x: 20,
			y: 25,
			width: 30,
			height: 30,
		});
	});

	it('drops invalid boxes', () => {
		expect(normalizeOutfitBoundingBox({ x: 10, y: 10, width: 0, height: 10 }, 100, 100)).toBeNull();
		expect(normalizeOutfitBoundingBox(null, 100, 100)).toBeNull();
	});
});

describe('outfitExtractionUserPrompt', () => {
	it('includes oriented pixel size', () => {
		const prompt = outfitExtractionUserPrompt(1350, 1800);
		expect(prompt).toContain('1350px wide × 1800px tall');
		expect(prompt).toContain('portrait');
	});
});
