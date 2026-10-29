import { describe, expect, it } from 'vitest';
import { IDENTITY_ENCODER, VECTORIZE_INDEX_DIMENSIONS } from '../src/services/identity/encode/embed.types';
import type { PreparedClosetCrop } from '../src/services/identity/encode/cropEncoder';
import {
	cosineSimilarity,
	mergeIdentityNeighbors,
	scoreUnindexedProbes,
} from '../src/services/identity/decide/unindexedFallback';
import type { ClosetMatchProbeEmbed } from '../src/db/closet';

const VECTOR = Array(VECTORIZE_INDEX_DIMENSIONS).fill(0);
VECTOR[0] = 1;

const PREPARED: PreparedClosetCrop = {
	model: IDENTITY_ENCODER,
	dimensions: VECTORIZE_INDEX_DIMENSIONS,
	index_dimensions: VECTORIZE_INDEX_DIMENSIONS,
	matches_index: true,
	vector_preview: VECTOR.slice(0, 8),
	crop_image_key: '',
	crop_image_url: '',
	crop_width: 0,
	crop_height: 0,
	source_image_key: 'users/u1/a.jpg',
	crop_color: { h: 10, s: 0.4, l: 0.4 },
	crop_blur_hash: null,
	vector: VECTOR,
};

function probe(overrides: Partial<ClosetMatchProbeEmbed> = {}): ClosetMatchProbeEmbed {
	return {
		encoder: IDENTITY_ENCODER,
		dimensions: VECTORIZE_INDEX_DIMENSIONS,
		vector: VECTOR,
		crop_color: { h: 10, s: 0.4, l: 0.4 },
		crop_blur_hash: null,
		...overrides,
	};
}

describe('unindexed fallback scoring', () => {
	it('scores same-slot unindexed probes with identity_score', () => {
		const matches = scoreUnindexedProbes({
			prepared: PREPARED,
			category: 'top',
			probes: [
				{
					closetItemId: 'prior-1',
					category: 'top',
					label: 'olive shirt',
					probeEmbed: probe(),
				},
				{
					closetItemId: 'pants-1',
					category: 'bottom',
					label: 'navy pants',
					probeEmbed: probe(),
				},
			],
		});

		expect(matches).toHaveLength(1);
		expect(matches[0]).toMatchObject({
			d1_closet_item_id: 'prior-1',
			closet_item_id: 'prior-1',
			score: 1,
			identity_score: 1,
		});
	});

	it('merges ANN and local neighbors preferring higher identity_score', () => {
		const merged = mergeIdentityNeighbors(
			[
				{
					id: 'item:a',
					score: 0.9,
					closet_item_id: 'a',
					d1_closet_item_id: 'a',
					d1_label: 'a',
					d1_subcategory: 'shirt',
					color_distance: 0.1,
					identity_score: 0.6,
				},
			],
			[
				{
					id: 'item:a',
					score: 0.95,
					closet_item_id: 'a',
					d1_closet_item_id: 'a',
					d1_label: 'a',
					d1_subcategory: 'shirt',
					color_distance: 0.02,
					identity_score: 0.9,
				},
				{
					id: 'item:b',
					score: 0.8,
					closet_item_id: 'b',
					d1_closet_item_id: 'b',
					d1_label: 'b',
					d1_subcategory: 'pants',
					color_distance: null,
					identity_score: 0.8,
				},
			]
		);

		expect(merged.map((row) => row.d1_closet_item_id)).toEqual(['a', 'b']);
		expect(merged[0].identity_score).toBe(0.9);
	});

	it('returns 1 for identical unit vectors', () => {
		expect(cosineSimilarity(VECTOR, VECTOR)).toBe(1);
	});
});
