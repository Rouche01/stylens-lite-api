import { describe, expect, it } from 'vitest';
import {
	CLOSET_MATCH_GET_COLUMNS,
	CLOSET_MATCH_LIST_COLUMNS,
	parseClosetMatchProbeEmbed,
	serializeClosetMatchProbeEmbed,
	type ClosetMatchProbeEmbed,
} from '../src/db/closet';
import { closetMatchProbeFromPrepared } from '../src/services/identity/processOutfitImage';
import type { PreparedClosetCrop } from '../src/services/identity';

const PROBE: ClosetMatchProbeEmbed = {
	encoder: 'dinov3-cls-v1',
	dimensions: 4,
	vector: [0.1, 0.2, 0.3, 0.4],
	crop_color: { h: 40, s: 0.2, l: 0.5 },
	crop_blur_hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
};

describe('closet match probe_embed', () => {
	it('round-trips a valid probe', () => {
		expect(parseClosetMatchProbeEmbed(serializeClosetMatchProbeEmbed(PROBE))).toEqual(PROBE);
	});

	it('returns null for missing, empty, or corrupt blobs', () => {
		expect(parseClosetMatchProbeEmbed(null)).toBeNull();
		expect(parseClosetMatchProbeEmbed('')).toBeNull();
		expect(parseClosetMatchProbeEmbed('not-json')).toBeNull();
		expect(parseClosetMatchProbeEmbed(JSON.stringify({ encoder: 'dinov3-cls-v1' }))).toBeNull();
	});

	it('rejects a vector whose length does not match dimensions', () => {
		expect(
			parseClosetMatchProbeEmbed(
				serializeClosetMatchProbeEmbed({ ...PROBE, dimensions: 8 })
			)
		).toBeNull();
	});

	it('list SELECT omits probe_embed; get SELECT includes it', () => {
		expect(CLOSET_MATCH_LIST_COLUMNS).not.toMatch(/probe_embed/);
		expect(CLOSET_MATCH_GET_COLUMNS).toMatch(/m\.probe_embed/);
	});
});

describe('closetMatchProbeFromPrepared', () => {
	const prepared: PreparedClosetCrop = {
		model: 'dino',
		dimensions: 4,
		index_dimensions: 4,
		matches_index: true,
		vector_preview: [],
		crop_image_key: 'scratch.jpg',
		crop_image_url: 'https://scratch',
		crop_width: 10,
		crop_height: 10,
		source_image_key: 'users/u1/a.jpg',
		crop_color: { h: 1, s: 0.2, l: 0.3 },
		crop_blur_hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
		vector: [0.1, 0.2, 0.3, 0.4],
	};

	it('pins IDENTITY_ENCODER and omits scratch R2 keys', () => {
		expect(closetMatchProbeFromPrepared(prepared)).toEqual({
			encoder: 'dinov3-cls-v1',
			dimensions: 4,
			vector: prepared.vector,
			crop_color: prepared.crop_color,
			crop_blur_hash: prepared.crop_blur_hash,
		});
	});

	it('returns null when vector length does not match dimensions', () => {
		expect(closetMatchProbeFromPrepared({ ...prepared, dimensions: 8 })).toBeNull();
		expect(closetMatchProbeFromPrepared({ ...prepared, vector: [] })).toBeNull();
	});
});
