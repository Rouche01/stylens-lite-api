import { describe, expect, it, vi } from 'vitest';
import type { ClosetItemMatchWithOutfit } from '../src/db/closet';
import {
	IdentityCalibrationLogEvents,
	buildResolveCalibrationLabel,
	logResolveCalibrationLabel,
	resolveCalibrationLabelLogContext,
} from '../src/services/identity/logging/calibrationLabel';
import type { ResolveClosetMatchResult } from '../src/services/identity/write/types';
import type { Logger } from '../src/utils/logger.utils';

function match(partial?: Partial<ClosetItemMatchWithOutfit>): ClosetItemMatchWithOutfit {
	return {
		id: 'match-1',
		user_id: 'user-1',
		outfit_id: 'outfit-1',
		candidate_closet_item_id: 'cand-1',
		bounding_box: { x: 0, y: 0, width: 10, height: 10 },
		confidence: 'high',
		extract_snapshot: {
			label: 'olive tee',
			category: 'top',
			subcategory: 't-shirt',
			color: 'olive',
			pattern: 'solid',
			styleTags: [],
		},
		score: 0.62,
		cosine: 0.71,
		color_distance: 0.12,
		band: 'ask',
		status: 'pending',
		created_at: 1,
		resolved_at: null,
		resolved_closet_item_id: null,
		probe_embed: null,
		outfit_image_key: 'photos/outfit.jpg',
		outfit_original_image_url: 'https://example.invalid/x',
		...partial,
	};
}

function result(partial?: Partial<ResolveClosetMatchResult>): ResolveClosetMatchResult {
	return {
		decision: 'same',
		match_id: 'match-1',
		closet_item_id: 'cand-1',
		candidate_closet_item_id: 'cand-1',
		identity_status: 'created',
		identity_reason: 'same',
		identity_score: 0.62,
		...partial,
	};
}

describe('buildResolveCalibrationLabel', () => {
	it('maps same → resolve_same / human same / link', () => {
		expect(buildResolveCalibrationLabel({ match: match(), decision: 'same', result: result() })).toEqual({
			source: 'resolve_same',
			human_verdict: 'same',
			expected_action: 'link',
			system_status: 'ask',
			system_reason: 'ask',
			match_id: 'match-1',
			user_id: 'user-1',
			image_key: 'photos/outfit.jpg',
			outfit_id: 'outfit-1',
			label: 'olive tee',
			category: 'top',
			identity_score: 0.62,
			cosine: 0.71,
			color_distance: 0.12,
			candidate_closet_item_id: 'cand-1',
			closet_item_id: 'cand-1',
			notes: 'match_id:match-1',
		});
	});

	it('maps new → resolve_new / human different / create', () => {
		const label = buildResolveCalibrationLabel({
			match: match(),
			decision: 'new',
			result: result({
				decision: 'new',
				closet_item_id: 'new-1',
				identity_reason: 'no_neighbor',
			}),
		});
		expect(label?.source).toBe('resolve_new');
		expect(label?.human_verdict).toBe('different');
		expect(label?.expected_action).toBe('create');
		expect(label?.closet_item_id).toBe('new-1');
	});

	it('returns null when resolve failed', () => {
		expect(
			buildResolveCalibrationLabel({
				match: match(),
				decision: 'new',
				result: result({
					decision: 'new',
					closet_item_id: null,
					identity_status: 'failed',
					identity_reason: 'embed_failed',
				}),
			})
		).toBeNull();
	});
});

describe('logResolveCalibrationLabel', () => {
	it('emits identity_calibration_label once for a clear resolve', () => {
		const info = vi.fn();
		const log = { info } as unknown as Logger;
		logResolveCalibrationLabel(log, {
			match: match(),
			decision: 'same',
			result: result(),
		});
		expect(info).toHaveBeenCalledWith(
			IdentityCalibrationLogEvents.LABEL,
			resolveCalibrationLabelLogContext(
				buildResolveCalibrationLabel({ match: match(), decision: 'same', result: result() })!
			)
		);
	});

	it('skips failed resolves', () => {
		const info = vi.fn();
		const log = { info } as unknown as Logger;
		logResolveCalibrationLabel(log, {
			match: match(),
			decision: 'new',
			result: result({ identity_status: 'failed', identity_reason: 'embed_failed', closet_item_id: null }),
		});
		expect(info).not.toHaveBeenCalled();
	});
});
