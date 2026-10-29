import { describe, it, expect } from 'vitest';
import { boxInCrop, CATALOG_BOX_PAD, closetTilePad, isUsableIdentityBox, nativeAspectFocusWindow, normalizeOutfitBoundingBox, padPercentBox, percentBoxIou, percentBoxToTrim, personInOutfitBox, photoOverlayInCrop, tileAspectRatio } from '../src/utils/bounding_box';
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

	it('rejects brim-only hat strips that pass area but are too short', () => {
		const brim = { x: 32.5, y: 45.1, width: 6.6, height: 3.2 };
		expect(isUsableIdentityBox(brim)).toBe(false);
		expect(isUsableIdentityBox(brim, { category: 'accessory', subcategory: 'hat' })).toBe(false);
		expect(
			isUsableIdentityBox(
				{ x: 43, y: 24, width: 15.6, height: 6.8 },
				{ category: 'accessory', subcategory: 'hat' }
			)
		).toBe(true);
	});
});

describe('outfitExtractionUserPrompt', () => {
	it('includes oriented pixel size', () => {
		const prompt = outfitExtractionUserPrompt(1350, 1800);
		expect(prompt).toContain('1350px wide × 1800px tall');
		expect(prompt).toContain('portrait');
	});
});

describe('padPercentBox', () => {
	it('expands by catalog pad without leaving the frame', () => {
		expect(padPercentBox({ x: 20, y: 20, width: 40, height: 50 })).toEqual({
			x: 16,
			y: 15,
			width: 48,
			height: 60,
		});
		expect(padPercentBox({ x: 0, y: 0, width: 10, height: 10 }).x).toBe(0);
	});

	it('adds extra bottom/side pad for footwear closet tiles', () => {
		const box = { x: 20, y: 70, width: 40, height: 20 };
		const catalog = padPercentBox(box);
		const shoes = padPercentBox(box, closetTilePad('footwear'));
		expect(shoes.y).toBeLessThan(catalog.y);
		expect(shoes.height).toBeGreaterThan(catalog.height);
		expect(shoes.width).toBeGreaterThan(catalog.width);
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

describe('boxInCrop', () => {
	it('maps a seed box into padded-crop local percents', () => {
		const seed = { x: 20, y: 20, width: 40, height: 50 };
		const crop = padPercentBox(seed);
		expect(crop).toEqual({ x: 16, y: 15, width: 48, height: 60 });
		expect(boxInCrop(seed, crop)).toEqual({
			x: (20 - 16) / 48 * 100,
			y: (20 - 15) / 60 * 100,
			width: 40 / 48 * 100,
			height: 50 / 60 * 100,
		});
	});

	it('clips a seed that only partly overlaps the crop', () => {
		expect(boxInCrop({ x: 0, y: 0, width: 20, height: 20 }, { x: 10, y: 10, width: 40, height: 40 })).toEqual({
			x: 0,
			y: 0,
			width: 25,
			height: 25,
		});
	});

	it('is omitted when the inner box misses the crop', () => {
		expect(boxInCrop({ x: 0, y: 0, width: 5, height: 5 }, { x: 50, y: 50, width: 20, height: 20 })).toBeNull();
		expect(boxInCrop({ x: 10, y: 10, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 })).toBeNull();
	});
});

describe('personInOutfitBox', () => {
	it('expands a top seed into a standing-person region that still contains the garment', () => {
		const seed = { x: 20, y: 30, width: 25, height: 22 };
		const person = personInOutfitBox(seed, 'top');
		expect(person.x).toBeLessThan(seed.x);
		expect(person.y).toBeLessThan(seed.y);
		expect(person.x + person.width).toBeGreaterThan(seed.x + seed.width);
		expect(person.y + person.height).toBeGreaterThan(seed.y + seed.height);
		expect(person.height).toBeLessThan(100);
	});

	it('reaches up from footwear toward the wearer', () => {
		const seed = { x: 30, y: 78, width: 22, height: 12 };
		const person = personInOutfitBox(seed, 'footwear');
		expect(person.y).toBeLessThan(seed.y - 20);
		expect(person.y + person.height).toBeGreaterThanOrEqual(seed.y + seed.height - 1e-6);
	});
});

describe('nativeAspectFocusWindow', () => {
	const contains = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) => {
		expect(outer.x).toBeLessThanOrEqual(inner.x + 1e-6);
		expect(outer.y).toBeLessThanOrEqual(inner.y + 1e-6);
		expect(outer.x + outer.width).toBeGreaterThanOrEqual(inner.x + inner.width - 1e-6);
		expect(outer.y + outer.height).toBeGreaterThanOrEqual(inner.y + inner.height - 1e-6);
	};

	it('keeps photo aspect, contains the seed, and clips extra wall', () => {
		const seed = { x: 20, y: 30, width: 25, height: 22 };
		const win = nativeAspectFocusWindow(seed, 1000, 1333, 'top');
		expect(win.width).toBeCloseTo(win.height, 5);
		contains(win, seed);
		expect(win.width).toBeLessThan(90);
		expect(win.height).toBeLessThan(90);
		const mapped = boxInCrop(seed, win);
		expect(mapped).not.toBeNull();
		const seedCx = mapped!.x + mapped!.width / 2;
		expect(seedCx).toBeGreaterThan(35);
		expect(seedCx).toBeLessThan(65);
	});

	it('does not grow a centered seed to the full frame', () => {
		const seed = { x: 40, y: 40, width: 20, height: 20 };
		const win = nativeAspectFocusWindow(seed, 1350, 1800, 'top');
		expect(win.width).toBeCloseTo(win.height, 5);
		contains(win, seed);
		expect(win.width).toBeLessThan(95);
		expect(win.height).toBeLessThan(95);
	});

	it('falls back to the full frame when size is unknown', () => {
		expect(nativeAspectFocusWindow({ x: 10, y: 10, width: 20, height: 20 }, 0, 1800, 'top')).toEqual({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
		});
	});
});

describe('photoOverlayInCrop', () => {
	it('expands a full-photo layer so a 20×40 crop window shows the right slice', () => {
		expect(photoOverlayInCrop({ x: 20, y: 10, width: 40, height: 50 })).toEqual({
			x: -50,
			y: -20,
			width: 250,
			height: 200,
		});
	});

	it('is omitted for an empty crop', () => {
		expect(photoOverlayInCrop({ x: 10, y: 10, width: 0, height: 20 })).toBeNull();
	});
});

describe('tileAspectRatio', () => {
	it('matches the padded isolate crop for a 3:4 photo', () => {
		const box = { x: 20, y: 20, width: 40, height: 50 };
		// pad trim: top 300, left 160, bottom 500, right 360 on 1000×2000 → 480×1200
		expect(tileAspectRatio(box, 1000, 2000)).toBe(0.4);
	});

	it('is omitted when photo size is unknown', () => {
		expect(tileAspectRatio({ x: 10, y: 10, width: 40, height: 40 }, 0, 1000)).toBeNull();
	});
});
