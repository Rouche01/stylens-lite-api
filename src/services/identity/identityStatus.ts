/**
 * Lightweight identity status model (no FSM library).
 * One next action per status — resume helpers key off these instead of ad-hoc checks.
 */

import type { ClosetIndexStatus } from '../../db/closet';

export type { ClosetIndexStatus };

export const CLOSET_INDEX_STATUSES = ['committed', 'indexing', 'indexed', 'index_degraded'] as const;

export type ClosetIndexNextAction =
	| 'enqueue_index'
	| 'await_or_retry_index'
	| 'none'
	| 'backfill_and_fallback';

export const CLOSET_MATCH_LIFECYCLES = ['pending', 'claimed', 'done'] as const;
export type ClosetMatchLifecycle = (typeof CLOSET_MATCH_LIFECYCLES)[number];

export type ClosetMatchLifecycleNextAction =
	| 'await_user'
	| 'resume_create'
	| 'resume_link'
	| 'none';

export function isClosetIndexStatus(value: unknown): value is ClosetIndexStatus {
	return typeof value === 'string' && (CLOSET_INDEX_STATUSES as readonly string[]).includes(value);
}

/**
 * Prefer vector_indexed_at as the source of truth for "searchable".
 * When unset, use index_status (default committed for legacy rows).
 */
export function resolveClosetIndexStatus(row: {
	index_status?: string | null;
	vector_indexed_at?: number | null;
}): ClosetIndexStatus {
	if (row.vector_indexed_at != null) return 'indexed';
	const raw = row.index_status?.trim();
	if (raw === 'indexing' || raw === 'index_degraded' || raw === 'committed') return raw;
	// Stale "indexed" without a stamp → still needs indexing.
	return 'committed';
}

export function nextActionForIndexStatus(status: ClosetIndexStatus): ClosetIndexNextAction {
	switch (status) {
		case 'committed':
			return 'enqueue_index';
		case 'indexing':
			return 'await_or_retry_index';
		case 'indexed':
			return 'none';
		case 'index_degraded':
			return 'backfill_and_fallback';
	}
}

/**
 * Match lifecycle derived from DB status + completion facts (no extra column).
 * claimed = CAS won but create/link not finished yet.
 */
export function resolveMatchLifecycle(
	match: {
		status: 'pending' | 'same' | 'new';
		resolved_closet_item_id?: string | null;
	},
	facts: {
		closetItemExists: boolean;
		wearLinked: boolean;
	}
): ClosetMatchLifecycle {
	if (match.status === 'pending') return 'pending';

	if (match.status === 'new') {
		const reserved = Boolean(match.resolved_closet_item_id?.trim());
		if (!reserved || !facts.closetItemExists || !facts.wearLinked) return 'claimed';
		return 'done';
	}

	// same
	if (!facts.wearLinked) return 'claimed';
	return 'done';
}

export function nextActionForMatchLifecycle(
	lifecycle: ClosetMatchLifecycle,
	decision: 'same' | 'new'
): ClosetMatchLifecycleNextAction {
	switch (lifecycle) {
		case 'pending':
			return 'await_user';
		case 'claimed':
			return decision === 'new' ? 'resume_create' : 'resume_link';
		case 'done':
			return 'none';
	}
}
