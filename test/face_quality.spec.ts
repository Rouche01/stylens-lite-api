import { describe, it, expect } from 'vitest';
import {
	cropLocalBoxPx,
	evaluateFaceRgba,
	faceCutoutPad,
	facePrefersSam3First,
	packshotRequiresTrustedCutout,
	passesFaceQuality,
	passesFootwearStudioCutout,
	usesGenerativePackshot,
} from '../src/services/segmentation/face_quality';
import { sam3PromptCandidates } from '../src/services/segmentation/sam3_prompt';

function rgbaFrame(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = paint(x, y);
			const i = (y * width + x) * 4;
			rgba[i] = r;
			rgba[i + 1] = g;
			rgba[i + 2] = b;
			rgba[i + 3] = a;
		}
	}
	return rgba;
}

describe('evaluateFaceRgba / passesFaceQuality', () => {
	it('accepts a solid garment with visible tone variation', () => {
		const rgba = rgbaFrame(100, 100, (x, y) => {
			if (x < 20 || x >= 80 || y < 10 || y >= 90) return [0, 0, 0, 0];
			const tone = 70 + ((x + y) % 40);
			return [tone, tone - 5, tone + 5, 255];
		});
		const metrics = evaluateFaceRgba(rgba, 100, 100, 0.9);
		const verdict = passesFaceQuality(metrics);
		expect(metrics.opaqueFrac).toBeCloseTo(0.48, 2);
		expect(metrics.meanLuma).toBeGreaterThan(18);
		expect(metrics.lumaStd).toBeGreaterThan(10);
		expect(verdict.ok).toBe(true);
	});

	it('rejects a tiny center blob like the boots matte failure', () => {
		const rgba = rgbaFrame(100, 100, (x, y) =>
			x >= 48 && x < 52 && y >= 48 && y < 55 ? [10, 10, 10, 255] : [0, 0, 0, 0]
		);
		const metrics = evaluateFaceRgba(rgba, 100, 100, 0.8);
		const verdict = passesFaceQuality(metrics);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/opaque_frac|opaque_bbox|mean_luma|fill_density/);
	});

	it('rejects near-black voids that still have high opaque_frac', () => {
		const rgba = rgbaFrame(80, 80, (x, y) =>
			x >= 10 && x < 70 && y >= 10 && y < 70 ? [4, 4, 4, 255] : [0, 0, 0, 0]
		);
		const metrics = evaluateFaceRgba(rgba, 80, 80, 0.9);
		expect(metrics.opaqueFrac).toBeGreaterThan(0.5);
		const verdict = passesFaceQuality(metrics);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/mean_luma|luma_std/);
	});

	it('rejects hollow outlines (low fill density)', () => {
		// Thin ring: clears opaque_frac floor but fill_density stays low (empty interior).
		const rgba = rgbaFrame(80, 80, (x, y) => {
			const inOuter = x >= 5 && x < 75 && y >= 5 && y < 75;
			const inHole = x >= 8 && x < 72 && y >= 8 && y < 72;
			if (inOuter && !inHole) return [130, 110, 100, 255];
			return [0, 0, 0, 0];
		});
		const metrics = evaluateFaceRgba(rgba, 80, 80, 0.9);
		expect(metrics.opaqueFrac).toBeGreaterThan(0.06);
		expect(metrics.fillDensity).toBeLessThan(0.22);
		expect(passesFaceQuality(metrics).ok).toBe(false);
		expect(passesFaceQuality(metrics).reason).toMatch(/fill_density/);
	});

	it('rejects low mask scores even when geometry looks fine', () => {
		const rgba = rgbaFrame(40, 40, (x, y) => {
			if (x < 5 || x >= 35 || y < 5 || y >= 35) return [0, 0, 0, 0];
			const tone = 60 + ((x * y) % 50);
			return [tone, tone, tone, 200];
		});
		const metrics = evaluateFaceRgba(rgba, 40, 40, 0.2);
		expect(passesFaceQuality(metrics).ok).toBe(false);
		expect(passesFaceQuality(metrics).reason).toMatch(/mask_score/);
	});

	it('applies stricter footwear thresholds (mid quality passes default, fails footwear)', () => {
		// Solid mid-tone block: clears default gate; mask_score 0.50 fails footwear (min 0.55).
		const rgba = rgbaFrame(100, 100, (x, y) => {
			if (x < 20 || x >= 80 || y < 10 || y >= 90) return [0, 0, 0, 0];
			const tone = 70 + ((x + y) % 40);
			return [tone, tone - 5, tone + 5, 255];
		});
		const metrics = evaluateFaceRgba(rgba, 100, 100, 0.5);
		expect(passesFaceQuality(metrics).ok).toBe(true);
		const footwear = passesFaceQuality(metrics, { category: 'footwear' });
		expect(footwear.ok).toBe(false);
		expect(footwear.reason).toMatch(/mask_score/);
	});

	it('routes footwear off the apparel generative enqueue path (trusted-cutout generative is in-path)', () => {
		expect(usesGenerativePackshot('footwear')).toBe(false);
		expect(usesGenerativePackshot('top')).toBe(true);
		expect(packshotRequiresTrustedCutout('footwear')).toBe(false);
		expect(packshotRequiresTrustedCutout('top')).toBe(false);
	});

	it('rejects holey footwear mattes for studio prefer-cutout even if store gate might pass', () => {
		// Sparse mid-tone blob: clears soft store-ish numbers, fails studio fill/opaque.
		const rgba = rgbaFrame(160, 180, (x, y) => {
			const inBlob = x > 40 && x < 120 && y > 40 && y < 140 && (x + y) % 3 !== 0;
			if (!inBlob) return [0, 0, 0, 0];
			const tone = 60 + ((x * 3 + y) % 50);
			return [tone, tone - 8, tone + 4, 255];
		});
		const metrics = evaluateFaceRgba(rgba, 160, 180, null);
		expect(passesFootwearStudioCutout(metrics).ok).toBe(false);
	});
});

describe('faceCutoutPad / cropLocalBoxPx / facePrefersSam3First', () => {
	it('tightens footwear pad vs default closet tile pad', () => {
		const footwear = faceCutoutPad('footwear');
		const top = faceCutoutPad('top');
		expect(footwear.max).toBeLessThanOrEqual(6);
		expect(footwear.fraction).toBeLessThan(top.fraction);
	});

	it('builds an inset full-frame box on the crop', () => {
		expect(cropLocalBoxPx(200, 100, 0.02)).toEqual([4, 2, 196, 98]);
	});

	it('prefers SAM3 first for footwear and accessory only', () => {
		expect(facePrefersSam3First('footwear')).toBe(true);
		expect(facePrefersSam3First('accessory')).toBe(true);
		expect(facePrefersSam3First('top')).toBe(false);
		expect(facePrefersSam3First(null)).toBe(false);
	});
});

describe('sam3PromptCandidates footwear', () => {
	it('maps black boots toward shoe nouns', () => {
		const prompts = sam3PromptCandidates('black boots');
		expect(prompts.some((p) => p.includes('boot') || p.includes('shoe'))).toBe(true);
		expect(prompts).toContain('shoe');
	});
});
