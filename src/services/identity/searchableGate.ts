import type { ClosetDB } from '../../db/closet';
import type { Logger } from '../../utils/logger.utils';
import { closetItemVectorId } from './vectorize.store';

/** Hold the writer until prior creates are searchable, then release or degrade. */
export const SEARCHABLE_GATE_TIMEOUT_MS = 15_000;
export const SEARCHABLE_GATE_POLL_MS = 500;
export const SEARCHABLE_GATE_USER_LIMIT = 50;

export type SearchableGateStore = Pick<
	ClosetDB,
	| 'listPendingIndexClosetItemIdsForUser'
	| 'getClosetItemSummary'
	| 'stampVectorIndexedAt'
	| 'setClosetIndexStatus'
>;

export type SearchableGateIdentity = {
	getVectorsByIds(ids: string[]): Promise<Array<{ id: string }>>;
};

export type SearchableGateWait = {
	timeoutMs: number;
	pollMs: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

export type SearchableGateResult = {
	indexed: string[];
	degraded: string[];
};

/**
 * Poll Vectorize until closet item ids are stamped indexed, or budget exhausts → index_degraded.
 * Never deletes vectors or rolls back D1 tiles.
 */
export async function awaitSearchableOrDegrade(params: {
	closetItemIds: readonly string[];
	closet: SearchableGateStore;
	identity: SearchableGateIdentity;
	wait: SearchableGateWait;
	log: Logger;
	reason: 'prior_creates';
}): Promise<SearchableGateResult> {
	const pending = new Set(
		params.closetItemIds.map((id) => id.trim()).filter(Boolean)
	);
	const indexed: string[] = [];
	const degraded: string[] = [];
	if (pending.size === 0) {
		return { indexed, degraded };
	}

	const deadline = params.wait.now() + Math.max(0, params.wait.timeoutMs);

	while (pending.size > 0) {
		for (const closetItemId of [...pending]) {
			const summary = await params.closet.getClosetItemSummary(closetItemId);
			if (!summary || summary.vector_indexed_at != null) {
				pending.delete(closetItemId);
				if (summary?.vector_indexed_at != null) indexed.push(closetItemId);
				continue;
			}
			if (summary.index_status === 'index_degraded') {
				pending.delete(closetItemId);
				degraded.push(closetItemId);
			}
		}
		if (pending.size === 0) break;

		const vectorIds = [...pending].map((id) => closetItemVectorId(id));
		const found = await params.identity.getVectorsByIds(vectorIds);
		const visible = new Set(found.map((row) => row.id));
		for (const closetItemId of [...pending]) {
			if (!visible.has(closetItemVectorId(closetItemId))) continue;
			await params.closet.stampVectorIndexedAt(closetItemId);
			pending.delete(closetItemId);
			indexed.push(closetItemId);
		}
		if (pending.size === 0) break;

		if (params.wait.now() >= deadline) {
			const newlyDegraded: string[] = [];
			for (const closetItemId of [...pending]) {
				await params.closet.setClosetIndexStatus(closetItemId, 'index_degraded');
				pending.delete(closetItemId);
				degraded.push(closetItemId);
				newlyDegraded.push(closetItemId);
			}
			params.log.warn('outfit_identity_searchable_gate_exhausted', {
				reason: params.reason,
				degraded_count: newlyDegraded.length,
				degraded_ids: newlyDegraded.slice(0, 10).join(','),
			});
			break;
		}

		const waitMs = Math.min(
			params.wait.pollMs,
			Math.max(0, deadline - params.wait.now())
		);
		if (waitMs <= 0) continue;
		await params.wait.sleep(waitMs);
	}

	if (indexed.length > 0) {
		params.log.info('outfit_identity_searchable_gate_indexed', {
			reason: params.reason,
			indexed_count: indexed.length,
		});
	}
	return { indexed, degraded };
}

export async function awaitPriorCreatesSearchable(params: {
	userId: string;
	closet: SearchableGateStore;
	identity: SearchableGateIdentity;
	wait: SearchableGateWait;
	log: Logger;
	limit?: number;
}): Promise<SearchableGateResult> {
	const ids = await params.closet.listPendingIndexClosetItemIdsForUser(
		params.userId,
		params.limit ?? SEARCHABLE_GATE_USER_LIMIT
	);
	return awaitSearchableOrDegrade({
		closetItemIds: ids,
		closet: params.closet,
		identity: params.identity,
		wait: params.wait,
		log: params.log,
		reason: 'prior_creates',
	});
}
