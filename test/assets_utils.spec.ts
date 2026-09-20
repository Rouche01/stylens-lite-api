import { describe, expect, it } from 'vitest';
import {
	CLOSET_TILE_ISOLATE_WIDTH,
	getIsolatedItemUrl,
	parseIsolateCutout,
	parseIsolatePad,
	parseIsolateWidth,
} from '../src/utils/assets.utils';
import {
	isolateCanonicalString,
	isolateDerivedKey,
	isolateOrientedKey,
	isSafeR2Key,
	type IsolateCacheParams,
} from '../src/utils/isolate_cache';

describe('parseIsolateWidth', () => {
	it('is omitted when the query is missing', () => {
		expect(parseIsolateWidth(undefined)).toBeUndefined();
		expect(parseIsolateWidth('')).toBeUndefined();
	});

	it('clamps tile-sized values and rejects garbage', () => {
		expect(parseIsolateWidth('480')).toBe(480);
		expect(parseIsolateWidth('8')).toBe(32);
		expect(parseIsolateWidth('99999')).toBe(2048);
		expect(parseIsolateWidth('nope')).toBeNull();
	});
});

describe('getIsolatedItemUrl', () => {
	const box = { x: 10, y: 20, width: 30, height: 40 };

	it('emits a tile URL without dummy img size or enhance', () => {
		const url = getIsolatedItemUrl({
			domain: 'api.example.com',
			imageUrl: 'https://unused',
			imageKey: 'users/u1/photo.jpg',
			boundingBox: box,
			width: CLOSET_TILE_ISOLATE_WIDTH,
		});
		expect(url).toBe(
			'https://api.example.com/assets/isolate?key=users%2Fu1%2Fphoto.jpg&x=10&y=20&w=30&h=40&width=480'
		);
	});

	it('keeps imgW/imgH when callers still pass dimensions', () => {
		const url = getIsolatedItemUrl({
			domain: 'https://api.example.com',
			imageUrl: 'https://unused',
			imageKey: 'photo.jpg',
			boundingBox: box,
			dimensions: { width: 1000, height: 1500 },
		});
		expect(url).toContain('imgW=1000');
		expect(url).toContain('imgH=1500');
		expect(url).not.toContain('width=');
	});

	it('appends enhance=true only when requested', () => {
		const url = getIsolatedItemUrl({
			domain: 'api.example.com',
			imageUrl: 'https://unused',
			imageKey: 'photo.jpg',
			boundingBox: box,
			enhance: true,
		});
		expect(url).toContain('enhance=true');
	});

	it('appends cutout=0 and category for a padded photo crop', () => {
		const url = getIsolatedItemUrl({
			domain: 'api.example.com',
			imageUrl: 'https://unused',
			imageKey: 'photo.jpg',
			boundingBox: box,
			width: CLOSET_TILE_ISOLATE_WIDTH,
			cutout: false,
			category: 'footwear',
		});
		expect(url).toContain('cutout=0');
		expect(url).toContain('category=footwear');
		expect(url).toContain('width=480');
		expect(url).not.toContain('pad=0');
	});

	it('appends pad=0 for an exact-box photo crop', () => {
		const url = getIsolatedItemUrl({
			domain: 'api.example.com',
			imageUrl: 'https://unused',
			imageKey: 'photo.jpg',
			boundingBox: box,
			width: 960,
			cutout: false,
			pad: false,
		});
		expect(url).toContain('cutout=0');
		expect(url).toContain('pad=0');
		expect(url).toContain('width=960');
	});
});

describe('parseIsolateCutout', () => {
	it('defaults to a foreground cutout', () => {
		expect(parseIsolateCutout(undefined)).toBe(true);
		expect(parseIsolateCutout('1')).toBe(true);
	});

	it('treats 0/false as a photo crop', () => {
		expect(parseIsolateCutout('0')).toBe(false);
		expect(parseIsolateCutout('false')).toBe(false);
	});
});

describe('parseIsolatePad', () => {
	it('defaults to applying pad', () => {
		expect(parseIsolatePad(undefined)).toBe(true);
		expect(parseIsolatePad('1')).toBe(true);
	});

	it('treats 0/false as an exact-box trim', () => {
		expect(parseIsolatePad('0')).toBe(false);
		expect(parseIsolatePad('false')).toBe(false);
	});
});

describe('isolate cache keys', () => {
	const base: IsolateCacheParams = {
		key: 'users/u1/photo.jpg',
		x: 10,
		y: 20,
		w: 30,
		h: 40,
		width: 480,
		cutout: false,
		pad: true,
		category: 'footwear',
	};

	it('collides 10 and 10.0 on the same source box', () => {
		const a = isolateCanonicalString({ ...base, x: parseFloat('10') });
		const b = isolateCanonicalString({ ...base, x: parseFloat('10.0') });
		expect(a).toBe(b);
		expect(a).toContain('|10|20|30|40|480|0|1|footwear');
	});

	it('uses full when width is omitted', () => {
		const { width: _width, ...rest } = base;
		expect(isolateCanonicalString(rest)).toContain('|full|0|1|footwear');
	});

	it('omits category when it does not change pixels', () => {
		expect(isolateCanonicalString({ ...base, cutout: true, category: 'footwear' })).toMatch(
			/\|1\|1\|$/,
		);
		expect(isolateCanonicalString({ ...base, pad: false, category: 'footwear' })).toMatch(
			/\|0\|0\|$/,
		);
	});

	it('hashes to derived/isolate/{sha256}.jpg for photo crops', async () => {
		const key = await isolateDerivedKey(base);
		expect(key).toMatch(/^derived\/isolate\/[0-9a-f]{64}\.jpg$/);
		expect(await isolateDerivedKey({ ...base, x: parseFloat('10.0') })).toBe(key);
	});

	it('uses .png when cutout is on', async () => {
		const key = await isolateDerivedKey({ ...base, cutout: true });
		expect(key).toMatch(/^derived\/isolate\/[0-9a-f]{64}\.png$/);
	});

	it('changes the derived key when pad category changes', async () => {
		const footwear = await isolateDerivedKey(base);
		const accessory = await isolateDerivedKey({ ...base, category: 'accessory' });
		expect(footwear).not.toBe(accessory);
	});

	it('builds an oriented key from a safe source key', () => {
		expect(isolateOrientedKey('users/u1/photo.jpg')).toBe('derived/oriented/users/u1/photo.jpg');
		expect(isolateOrientedKey('../secret')).toBeNull();
		expect(isolateOrientedKey('/absolute.jpg')).toBeNull();
		expect(isSafeR2Key('users/u1/photo.jpg')).toBe(true);
		expect(isSafeR2Key('..')).toBe(false);
	});
});
