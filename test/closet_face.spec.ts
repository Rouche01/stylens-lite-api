import { describe, it, expect } from 'vitest';
import {
	closetFaceImageKey,
	faceSourceFromKeys,
	isClosetPackshotReady,
	resolveClosetFaceSource,
} from '../src/utils/closet_face';

describe('closet_face prefer order', () => {
	it('prefers flatlay over cutout over crop', () => {
		expect(
			resolveClosetFaceSource({
				cutout_image_key: 'cutouts/a.png',
				flatlay_image_key: 'cutouts/b.png',
			})
		).toBe('flatlay');
		expect(resolveClosetFaceSource({ cutout_image_key: 'cutouts/a.png' })).toBe('cutout');
		expect(resolveClosetFaceSource({})).toBe('crop');
	});

	it('returns the R2 key for the preferred face', () => {
		expect(
			closetFaceImageKey({
				cutout_image_key: 'cutouts/a.png',
				flatlay_image_key: 'cutouts/b.png',
			})
		).toBe('cutouts/b.png');
		expect(closetFaceImageKey({ cutout_image_key: 'cutouts/a.png' })).toBe('cutouts/a.png');
		expect(closetFaceImageKey({})).toBeNull();
	});

	it('derives face_source from keys', () => {
		expect(faceSourceFromKeys({ flatlayImageKey: 'x' })).toBe('flatlay');
		expect(faceSourceFromKeys({ cutoutImageKey: 'x' })).toBe('cutout');
		expect(faceSourceFromKeys({})).toBe('crop');
	});

	it('treats whitespace-only keys as missing', () => {
		expect(resolveClosetFaceSource({ cutout_image_key: '  ', flatlay_image_key: '\t' })).toBe('crop');
		expect(closetFaceImageKey({ cutout_image_key: '   ' })).toBeNull();
	});

	it('isClosetPackshotReady only when flatlay key is set', () => {
		expect(isClosetPackshotReady({ flatlay_image_key: 'cutouts/x.png' })).toBe(true);
		expect(isClosetPackshotReady({ flatlay_image_key: '  ' })).toBe(false);
		expect(isClosetPackshotReady({})).toBe(false);
	});
});
