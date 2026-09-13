import { describe, it, expect } from 'vitest';
import { CATALOG_BOX_PAD, isUsableIdentityBox, normalizeOutfitBoundingBox, percentBoxIou, percentBoxToTrim } from '../src/utils/bounding_box';
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

describe('percentBoxIou', () => {
	it('is 1 for identical boxes and 0 for disjoint boxes', () => {
		const box = { x: 10, y: 10, width: 40, height: 40 };
		expect(percentBoxIou(box, box)).toBe(1);
		expect(percentBoxIou(box, { x: 60, y: 60, width: 10, height: 10 })).toBe(0);
	});
});

describe('isUsableIdentityBox', () => {
	it('rejects tiny false boxes and keeps garment-sized crops', () => {
		expect(isUsableIdentityBox({ x: 0, y: 0, width: 1, height: 1 })).toBe(false);
		expect(isUsableIdentityBox({ x: 20, y: 15, width: 40, height: 35 })).toBe(true);
	});
});

describe('outfitExtractionUserPrompt', () => {
	it('includes oriented pixel size', () => {
		const prompt = outfitExtractionUserPrompt(1350, 1800);
		expect(prompt).toContain('1350px wide × 1800px tall');
		expect(prompt).toContain('portrait');
	});
});

describe('percentBoxToTrim', () => {
	const box = { x: 20, y: 20, width: 40, height: 50 };

	it('maps percents to CF Images edge trims without pad', () => {
		expect(percentBoxToTrim(box, 1000, 2000)).toEqual({
			top: 400,
			left: 200,
			bottom: 600,
			right: 400,
		});
	});

	it('applies catalog pad (~10% of box, clamped 1–5) the same as Lens search', () => {
		// padW = max(1, min(5, 4)) = 4; padH = max(1, min(5, 5)) = 5
		expect(percentBoxToTrim(box, 1000, 2000, CATALOG_BOX_PAD)).toEqual({
			top: 300,
			left: 160,
			bottom: 500,
			right: 360,
		});
	});

	it('does not pad past the frame', () => {
		expect(percentBoxToTrim({ x: 0, y: 0, width: 10, height: 10 }, 1000, 1000, CATALOG_BOX_PAD)).toEqual({
			top: 0,
			left: 0,
			bottom: 880,
			right: 880,
		});
		expect(percentBoxToTrim({ x: 90, y: 90, width: 10, height: 10 }, 1000, 1000, CATALOG_BOX_PAD)).toEqual({
			top: 890,
			left: 890,
			bottom: 0,
			right: 0,
		});
	});
});
