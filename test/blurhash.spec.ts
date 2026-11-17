import { describe, expect, it } from 'vitest';
import { encodeBlurHash4x3 } from '../src/utils/blurhash';

function solidRgba(width: number, height: number, r: number, g: number, b: number): Uint8Array {
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		pixels.set([r, g, b, 255], i * 4);
	}
	return pixels;
}

describe('encodeBlurHash4x3', () => {
	it('encodes a 32×32 crop', () => {
		const hash = encodeBlurHash4x3(solidRgba(32, 32, 180, 140, 90), 32, 32);
		expect(hash).toEqual(expect.any(String));
		expect(hash!.length).toBeGreaterThan(6);
	});

	it('returns null when the frame is smaller than 4×3 components', () => {
		expect(encodeBlurHash4x3(solidRgba(2, 2, 0, 0, 0), 2, 2)).toBeNull();
	});
});
