import { describe, expect, it } from 'vitest';
import type { ClosetIndexStatus } from '../src/db/closet';
import {
	awaitPriorCreatesSearchable,
	awaitSearchableOrDegrade,
} from '../src/services/identity/searchableGate';
import { closetItemVectorId } from '../src/services/identity/vectorize.store';
import type { Logger } from '../src/utils/logger.utils';

describe('awaitSearchableOrDegrade', () => {
	it('stamps items visible in Vectorize', async () => {
		const harness = createGateHarness({
			visibleIds: [closetItemVectorId('a1')],
			items: [{ id: 'a1', index_status: 'indexing' }],
		});

		const result = await awaitSearchableOrDegrade({
			closetItemIds: ['a1'],
			closet: harness.closet,
			identity: harness.identity,
			wait: { timeoutMs: 0, pollMs: 0, now: Date.now, sleep: async () => {} },
			log: silentLogger(),
			reason: 'prior_creates',
		});

		expect(result).toEqual({ indexed: ['a1'], degraded: [] });
		expect(harness.closet.items[0].index_status).toBe('indexed');
		expect(harness.closet.items[0].vector_indexed_at).toBeTruthy();
	});

	it('marks index_degraded when the budget expires without visibility', async () => {
		const harness = createGateHarness({
			visibleIds: [],
			items: [{ id: 'a1', index_status: 'indexing' }],
		});

		const result = await awaitSearchableOrDegrade({
			closetItemIds: ['a1'],
			closet: harness.closet,
			identity: harness.identity,
			wait: { timeoutMs: 0, pollMs: 0, now: Date.now, sleep: async () => {} },
			log: silentLogger(),
			reason: 'prior_creates',
		});

		expect(result).toEqual({ indexed: [], degraded: ['a1'] });
		expect(harness.closet.items[0].index_status).toBe('index_degraded');
		expect(harness.closet.items[0].vector_indexed_at).toBeNull();
	});

	it('skips ids that are already degraded', async () => {
		const harness = createGateHarness({
			visibleIds: [],
			items: [{ id: 'a1', index_status: 'index_degraded' }],
		});

		const result = await awaitSearchableOrDegrade({
			closetItemIds: ['a1'],
			closet: harness.closet,
			identity: harness.identity,
			wait: { timeoutMs: 1000, pollMs: 10, now: Date.now, sleep: async () => {} },
			log: silentLogger(),
			reason: 'prior_creates',
		});

		expect(result).toEqual({ indexed: [], degraded: ['a1'] });
		expect(harness.identity.getByIdsCalls).toHaveLength(0);
	});
});

describe('awaitPriorCreatesSearchable', () => {
	it('only gates committed/indexing rows for the user', async () => {
		const harness = createGateHarness({
			visibleIds: [closetItemVectorId('pending-1')],
			items: [
				{ id: 'pending-1', user_id: 'u1', index_status: 'indexing' },
				{ id: 'done-1', user_id: 'u1', index_status: 'indexed', vector_indexed_at: 1 },
				{ id: 'degraded-1', user_id: 'u1', index_status: 'index_degraded' },
				{ id: 'other-1', user_id: 'u2', index_status: 'indexing' },
			],
		});

		const result = await awaitPriorCreatesSearchable({
			userId: 'u1',
			closet: harness.closet,
			identity: harness.identity,
			wait: { timeoutMs: 0, pollMs: 0, now: Date.now, sleep: async () => {} },
			log: silentLogger(),
		});

		expect(result.indexed).toEqual(['pending-1']);
		expect(result.degraded).toEqual([]);
		expect(harness.identity.getByIdsCalls).toEqual([[closetItemVectorId('pending-1')]]);
	});
});

function createGateHarness(options: {
	visibleIds: string[];
	items: Array<{
		id: string;
		user_id?: string;
		index_status: ClosetIndexStatus | null;
		vector_indexed_at?: number | null;
	}>;
}) {
	const closet = {
		items: options.items.map((item) => ({
			id: item.id,
			user_id: item.user_id ?? 'u1',
			label: 'item',
			category: 'top',
			vector_indexed_at: item.vector_indexed_at ?? null,
			index_status: item.index_status,
			index_attempts: 0,
		})),
		async listPendingIndexClosetItemIdsForUser(userId: string, limit = 50) {
			return this.items
				.filter(
					(item) =>
						item.user_id === userId &&
						item.vector_indexed_at == null &&
						(item.index_status === 'committed' || item.index_status === 'indexing')
				)
				.slice(0, limit)
				.map((item) => item.id);
		},
		async getClosetItemSummary(itemId: string) {
			const item = this.items.find((row) => row.id === itemId);
			return item
				? {
						id: item.id,
						user_id: item.user_id,
						label: item.label,
						category: item.category,
						vector_indexed_at: item.vector_indexed_at,
						index_status: item.index_status,
						index_attempts: item.index_attempts,
					}
				: null;
		},
		async stampVectorIndexedAt(itemId: string, atMs = Date.now()) {
			const item = this.items.find((row) => row.id === itemId);
			if (!item || item.vector_indexed_at != null) return false;
			item.vector_indexed_at = atMs;
			item.index_status = 'indexed';
			return true;
		},
		async setClosetIndexStatus(itemId: string, status: 'committed' | 'indexing' | 'index_degraded') {
			const item = this.items.find((row) => row.id === itemId);
			if (!item || item.vector_indexed_at != null) return false;
			item.index_status = status;
			return true;
		},
	};
	const identity = {
		getByIdsCalls: [] as string[][],
		async getVectorsByIds(ids: string[]) {
			this.getByIdsCalls.push(ids);
			return options.visibleIds.filter((id) => ids.includes(id)).map((id) => ({ id }));
		},
	};
	return { closet, identity };
}

function silentLogger(): Logger {
	const log: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return log;
		},
	};
	return log;
}
