import { describe, expect, it } from 'vitest';
import {
	CLOSET_TILE_ISOLATE_WIDTH,
	getIsolatedItemUrl,
	parseIsolateWidth,
} from '../src/utils/assets.utils';

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
});
