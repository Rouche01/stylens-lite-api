/**
 * Free calibration labels from pending-match resolve (`same` / `new`).
 * Emit once on first successful claim — not on resume / vector-repair retries.
 *
 * Sheet mapping: append to `.cursor/identity_calibration_reviews.local.md` with
 * `source: resolve_same | resolve_new`. Join by `outfit_id` + `image_key` + label;
 * `match_id` is in notes / log context (no separate sheet column).
 *
 * @see docs/identity_calibration_review.md
 */

import type { ClosetItemMatchWithOutfit } from '../../../db/closet';
import type { LogContext, Logger } from '../../../utils/logger.utils';
import type { ResolveClosetMatchResult } from '../write/types';

export const IdentityCalibrationLogEvents = {
	LABEL: 'identity_calibration_label',
} as const;

export type CalibrationHumanVerdict = 'same' | 'different' | 'unclear';
export type CalibrationLabelSource = 'resolve_same' | 'resolve_new' | 'manual_log';
export type CalibrationExpectedAction = 'create' | 'ask' | 'link';

/** Sheet-ready fields from a successful pending-match resolve. */
export type ResolveCalibrationLabel = {
	source: 'resolve_same' | 'resolve_new';
	human_verdict: 'same' | 'different';
	expected_action: 'link' | 'create';
	/** System decision before resolve (pending ask). */
	system_status: 'ask';
	system_reason: 'ask';
	match_id: string;
	user_id: string;
	image_key: string;
	outfit_id: string;
	label: string;
	category: string;
	identity_score: number | null;
	cosine: number | null;
	color_distance: number | null;
	candidate_closet_item_id: string;
	closet_item_id: string | null;
	notes: string;
};

/**
 * Map a first-claim resolve onto calibration sheet fields.
 * `same` → human same / link; `new` → human different / create.
 * Returns null when the resolve failed (not a clear label).
 */
export function buildResolveCalibrationLabel(params: {
	match: ClosetItemMatchWithOutfit;
	decision: 'same' | 'new';
	result: ResolveClosetMatchResult;
}): ResolveCalibrationLabel | null {
	if (params.result.identity_status === 'failed') return null;

	const snap = params.match.extract_snapshot;
	const label = snap.label?.trim() || '';
	const category = snap.category?.trim() || '';
	const source = params.decision === 'same' ? 'resolve_same' : 'resolve_new';

	return {
		source,
		human_verdict: params.decision === 'same' ? 'same' : 'different',
		expected_action: params.decision === 'same' ? 'link' : 'create',
		system_status: 'ask',
		system_reason: 'ask',
		match_id: params.match.id,
		user_id: params.match.user_id,
		image_key: params.match.outfit_image_key,
		outfit_id: params.match.outfit_id,
		label,
		category,
		identity_score: params.result.identity_score ?? params.match.score,
		cosine: params.match.cosine,
		color_distance: params.match.color_distance,
		candidate_closet_item_id: params.match.candidate_closet_item_id,
		closet_item_id: params.result.closet_item_id,
		notes: `match_id:${params.match.id}`,
	};
}

export function resolveCalibrationLabelLogContext(label: ResolveCalibrationLabel): LogContext {
	return {
		match_id: label.match_id,
		user_id: label.user_id,
		image_key: label.image_key,
		outfit_id: label.outfit_id,
		label: label.label,
		category: label.category,
		system_status: label.system_status,
		system_reason: label.system_reason,
		identity_score: label.identity_score,
		cosine: label.cosine,
		color_distance: label.color_distance,
		candidate_closet_item_id: label.candidate_closet_item_id,
		closet_item_id: label.closet_item_id,
		human_verdict: label.human_verdict,
		expected_action: label.expected_action,
		source: label.source,
		notes: label.notes,
	};
}

/** Fail-open: never throws. */
export function logResolveCalibrationLabel(
	log: Logger,
	params: {
		match: ClosetItemMatchWithOutfit;
		decision: 'same' | 'new';
		result: ResolveClosetMatchResult;
	}
): void {
	try {
		const label = buildResolveCalibrationLabel(params);
		if (!label) return;
		log.info(IdentityCalibrationLogEvents.LABEL, resolveCalibrationLabelLogContext(label));
	} catch {
		// observability only
	}
}
