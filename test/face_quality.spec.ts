import { describe, it, expect } from 'vitest';
import {
	cropLocalBoxPx,
	evaluateFaceRgba,
	faceCutoutPad,
	passesFaceQuality,
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
	it('accepts a solid garment occupying a healthy share of the frame', () => {
		const rgba = rgbaFrame(100, 100, (x, y) =>
			x >= 20 && x < 80 && y >= 10 && y < 90 ? [40, 40, 40, 255] : [0, 0, 0, 0]
		);
		const metrics = evaluateFaceRgba(rgba, 100, 100, 0.9);
		const verdict = passesFaceQuality(metrics);
		expect(metrics.opaqueFrac).toBeCloseTo(0.48, 2);
		expect(verdict.ok).toBe(true);
	});

	it('rejects a tiny center blob like the boots matte failure', () => {
		const rgba = rgbaFrame(100, 100, (x, y) =>
			x >= 48 && x < 52 && y >= 48 && y < 55 ? [10, 10, 10, 255] : [0, 0, 0, 0]
		);
		const metrics = evaluateFaceRgba(rgba, 100, 100, 0.8);
		const verdict = passesFaceQuality(metrics);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/opaque_frac|opaque_bbox/);
	});

	it('rejects low mask scores even when geometry looks fine', () => {
		const rgba = rgbaFrame(40, 40, (x, y) =>
			x >= 5 && x < 35 && y >= 5 && y < 35 ? [20, 20, 20, 200] : [0, 0, 0, 0]
		);
		const metrics = evaluateFaceRgba(rgba, 40, 40, 0.2);
		expect(passesFaceQuality(metrics).ok).toBe(false);
		expect(passesFaceQuality(metrics).reason).toMatch(/mask_score/);
	});
});

describe('faceCutoutPad / cropLocalBoxPx', () => {
	it('tightens footwear pad vs default closet tile pad', () => {
		const footwear = faceCutoutPad('footwear');
		const top = faceCutoutPad('top');
		expect(footwear.max).toBeLessThanOrEqual(6);
		expect(footwear.fraction).toBeLessThan(top.fraction);
	});

	it('builds an inset full-frame box on the crop', () => {
		expect(cropLocalBoxPx(200, 100, 0.02)).toEqual([4, 2, 196, 98]);
	});
});

describe('sam3PromptCandidates footwear', () => {
	it('maps black boots toward shoe nouns', () => {
		const prompts = sam3PromptCandidates('black boots');
		expect(prompts.some((p) => p.includes('boot') || p.includes('shoe'))).toBe(true);
		expect(prompts).toContain('shoe');
	});
});
