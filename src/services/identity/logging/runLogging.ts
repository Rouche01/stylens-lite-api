/**
 * Identity run logging contract (observability only).
 *
 * Correlation key: `identity_run_id` — one UUID per photo job (enqueue → queue → process).
 * Attach via `log.child(identityRunChildContext(...))` so encoder/query/decide events inherit it.
 *
 * Privacy:
 * - Log: image_key, ids, scores, reasons, slot, label/category (already used elsewhere).
 * - Do not log: signed URLs, prompts, crop image bytes / base64, full extract JSON.
 * - LogContext is flat scalars only — nest lists as JSON strings (e.g. `items_json`).
 *
 * Fail-open: callers must catch around logging; helpers here are pure and do not throw on bad input.
 *
 * @see .cursor/plans/identity_run_logging_81ec5356.plan.md
 */

import type { LogContext } from '../../../utils/logger.utils';
import type { ProcessedOutfitItem } from '../write/types';

/** Cap per-item rows on `closet_identity_completed` so a noisy extract cannot explode log size. */
export const IDENTITY_RUN_ITEMS_LOG_CAP = 20;

/** Snake_case event names for identity run observability. */
export const IdentityRunLogEvents = {
	ENQUEUE_SKIPPED: 'closet_identity_enqueue_skipped',
	ENQUEUE_RESULT: 'closet_identity_enqueue_result',
	ENQUEUE_FAILED: 'closet_identity_enqueue_failed',
	RUN_ID_MINTED_AT_CONSUMER: 'identity_run_id_minted_at_consumer',
	JOB_STARTED: 'closet_identity_job_started',
	JOB_COMPLETED: 'closet_identity_completed',
	JOB_FAILED: 'closet_identity_failed',
	JOB_BUSY: 'closet_identity_busy',
	JOB_GAVE_UP: 'closet_identity_gave_up',
} as const;

export type IdentityRunLogEvent = (typeof IdentityRunLogEvents)[keyof typeof IdentityRunLogEvents];

/** Classification / gate skip reasons (extend existing flag-gate reasons). */
export type IdentityEnqueueSkipReason =
	| 'missing_auth_id'
	| 'flag_gate_unavailable'
	| 'closet_browse_off'
	| 'missing_user_or_enqueue'
	| 'no_outfit_tag';

/**
 * Shared child-logger fields for one photo identity run.
 * Optional fields are omitted when unknown (do not pass empty strings).
 */
export type IdentityRunChildFields = {
	identity_run_id: string;
	user_id?: string;
	image_key?: string;
	session_id?: string;
	entry_id?: string;
	outfit_id?: string;
};

/** Compact per-item row for completed-run calibration. */
export type IdentityRunItemLogRow = {
	label: string | null;
	category: string | null;
	identity_status: ProcessedOutfitItem['identity_status'];
	identity_reason: string;
	identity_score: number | null;
	candidate_closet_item_id: string | null;
	closet_item_id: string | null;
};

export type IdentityRunItemSummary = {
	item_count: number;
	created: number;
	asked: number;
	failed: number;
	existing_crop: number;
	/** Cap-truncated rows for logging / calibration. */
	items: IdentityRunItemLogRow[];
	/** True when `items.length` is less than `item_count` due to {@link IDENTITY_RUN_ITEMS_LOG_CAP}. */
	items_truncated: boolean;
};

export function mintIdentityRunId(): string {
	return crypto.randomUUID();
}

/** Build flat LogContext for `log.child(...)` — omits undefined/empty optional fields. */
export function identityRunChildContext(fields: IdentityRunChildFields): LogContext {
	const ctx: LogContext = { identity_run_id: fields.identity_run_id };
	if (fields.user_id?.trim()) ctx.user_id = fields.user_id.trim();
	if (fields.image_key?.trim()) ctx.image_key = fields.image_key.trim();
	if (fields.session_id?.trim()) ctx.session_id = fields.session_id.trim();
	if (fields.entry_id?.trim()) ctx.entry_id = fields.entry_id.trim();
	if (fields.outfit_id?.trim()) ctx.outfit_id = fields.outfit_id.trim();
	return ctx;
}

/**
 * Summarize processed items for `closet_identity_completed`.
 * `existing_crop` is counted separately from other `created` decisions.
 */
export function summarizeIdentityRunItems(
	items: readonly ProcessedOutfitItem[],
	cap: number = IDENTITY_RUN_ITEMS_LOG_CAP
): IdentityRunItemSummary {
	let created = 0;
	let asked = 0;
	let failed = 0;
	let existing_crop = 0;

	for (const item of items) {
		if (item.identity_reason === 'existing_crop') {
			existing_crop += 1;
			continue;
		}
		if (item.identity_status === 'ask') {
			asked += 1;
			continue;
		}
		if (item.identity_status === 'failed') {
			failed += 1;
			continue;
		}
		created += 1;
	}

	const capped = items.slice(0, Math.max(0, cap));
	return {
		item_count: items.length,
		created,
		asked,
		failed,
		existing_crop,
		items: capped.map(toIdentityRunItemLogRow),
		items_truncated: capped.length < items.length,
	};
}

export function toIdentityRunItemLogRow(item: ProcessedOutfitItem): IdentityRunItemLogRow {
	return {
		label: item.label?.trim() ? item.label : null,
		category: item.category?.trim() ? item.category : null,
		identity_status: item.identity_status,
		identity_reason: String(item.identity_reason),
		identity_score: item.identity_score,
		candidate_closet_item_id: item.candidate_closet_item_id,
		closet_item_id: item.closet_item_id,
	};
}

/**
 * Flat fields safe for Logger LogContext (arrays → `items_json`).
 * Does not include signed URLs or image bytes.
 */
export function identityRunCompletedLogContext(params: {
	identity_run_id: string;
	user_id: string;
	image_key: string;
	outfit_id: string;
	summary: IdentityRunItemSummary;
	session_id?: string;
	entry_id?: string;
}): LogContext {
	const ctx: LogContext = {
		...identityRunChildContext({
			identity_run_id: params.identity_run_id,
			user_id: params.user_id,
			image_key: params.image_key,
			outfit_id: params.outfit_id,
			session_id: params.session_id,
			entry_id: params.entry_id,
		}),
		item_count: params.summary.item_count,
		created: params.summary.created,
		asked: params.summary.asked,
		failed: params.summary.failed,
		existing_crop: params.summary.existing_crop,
		items_truncated: params.summary.items_truncated,
		items_json: JSON.stringify(params.summary.items),
	};
	return ctx;
}

/** Comma-join keys for scalar LogContext (no URLs). */
export function joinImageKeysForLog(keys: readonly string[]): string {
	return keys.filter((k) => k.trim().length > 0).join(',');
}
