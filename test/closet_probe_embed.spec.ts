import { describe, expect, it } from 'vitest';
import {
	CLOSET_MATCH_GET_COLUMNS,
	CLOSET_MATCH_LIST_COLUMNS,
	parseClosetMatchProbeEmbed,
	serializeClosetMatchProbeEmbed,
	type ClosetMatchProbeEmbed,
} from '../src/db/closet';
import { closetMatchProbeFromPrepared, preparedFromProbeEmbed } from '../src/services/identity/processOutfitImage';
import { pendingClosetMatchClientPayload } from '../src/routes/closet/handlers/pendingClosetMatchPayload';
import { IDENTITY_ENCODER, VECTORIZE_INDEX_DIMENSIONS } from '../src/services/identity/embed.types';
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

describe('preparedFromProbeEmbed', () => {
	const current: ClosetMatchProbeEmbed = {
		encoder: IDENTITY_ENCODER,
		dimensions: VECTORIZE_INDEX_DIMENSIONS,
		vector: Array(VECTORIZE_INDEX_DIMENSIONS).fill(0.1),
		crop_color: { h: 40, s: 0.2, l: 0.5 },
		crop_blur_hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
	};

	it('hydrates a current-encoder probe', () => {
		const prepared = preparedFromProbeEmbed(current, 'users/u1/test.jpg');
		expect(prepared?.model).toBe(IDENTITY_ENCODER);
		expect(prepared?.dimensions).toBe(VECTORIZE_INDEX_DIMENSIONS);
		expect(prepared?.vector).toHaveLength(VECTORIZE_INDEX_DIMENSIONS);
		expect(prepared?.source_image_key).toBe('users/u1/test.jpg');
	});

	it('returns null for missing or stale probes so resolve can fall back', () => {
		expect(preparedFromProbeEmbed(null)).toBeNull();
		expect(preparedFromProbeEmbed({ ...current, encoder: 'jina-clip-v2' })).toBeNull();
		expect(preparedFromProbeEmbed({ ...current, dimensions: 4, vector: [0.1, 0.2, 0.3, 0.4] })).toBeNull();
	});
});

describe('pending closet match client JSON', () => {
	it('does not expose probe_embed or the vector blob', () => {
		const payload = pendingClosetMatchClientPayload(
			{
				id: 'match-1',
				user_id: 'u1',
				outfit_id: 'outfit-1',
				candidate_closet_item_id: 'c1',
				bounding_box: { x: 20, y: 15, width: 40, height: 35 },
				confidence: 'high',
				extract_snapshot: {
					label: 'olive shirt',
					category: 'top',
					subcategory: 'shirt',
					color: 'olive',
					pattern: 'solid',
					styleTags: [],
				},
				score: 0.77,
				cosine: 0.96,
				color_distance: 0.03,
				band: 'ask',
				status: 'pending',
				created_at: 1,
				resolved_at: null,
				resolved_closet_item_id: null,
				probe_embed: {
					encoder: IDENTITY_ENCODER,
					dimensions: VECTORIZE_INDEX_DIMENSIONS,
					vector: Array(VECTORIZE_INDEX_DIMENSIONS).fill(0.1),
					crop_color: null,
					crop_blur_hash: null,
				},
				outfit_image_key: 'users/u1/test.jpg',
				outfit_original_image_url: 'https://img/test.jpg',
			},
			{
				probeOriginalUrl: 'https://signed/probe.jpg',
				candidateDetails: null,
			}
		);

		const json = JSON.stringify(payload);
		expect(payload).not.toHaveProperty('probe_embed');
		expect(payload.probe).not.toHaveProperty('vector');
		expect(json).not.toContain('probe_embed');
		expect(json).not.toContain('"vector"');
		expect(payload.probe).toMatchObject({
			label: 'olive shirt',
			category: 'top',
			image_key: 'users/u1/test.jpg',
			bounding_box: { x: 20, y: 15, width: 40, height: 35 },
		});
	});
});
