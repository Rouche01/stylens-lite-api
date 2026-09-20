import { describe, expect, it } from 'vitest';
import {
	nextActionForIndexStatus,
	nextActionForMatchLifecycle,
	resolveClosetIndexStatus,
	resolveMatchLifecycle,
} from '../src/services/identity/decide/identityStatus';

describe('closet index status', () => {
	it('treats vector_indexed_at as indexed regardless of column', () => {
		expect(resolveClosetIndexStatus({ vector_indexed_at: 1, index_status: 'committed' })).toBe(
			'indexed'
		);
		expect(nextActionForIndexStatus('indexed')).toBe('none');
	});

	it('defaults null stamp + null status to committed', () => {
		expect(resolveClosetIndexStatus({})).toBe('committed');
		expect(resolveClosetIndexStatus({ vector_indexed_at: null, index_status: null })).toBe(
			'committed'
		);
		expect(nextActionForIndexStatus('committed')).toBe('enqueue_index');
	});

	it('preserves indexing and index_degraded when not stamped', () => {
		expect(resolveClosetIndexStatus({ index_status: 'indexing' })).toBe('indexing');
		expect(nextActionForIndexStatus('indexing')).toBe('await_or_retry_index');
		expect(resolveClosetIndexStatus({ index_status: 'index_degraded' })).toBe('index_degraded');
		expect(nextActionForIndexStatus('index_degraded')).toBe('backfill_and_fallback');
	});

	it('treats stale indexed without stamp as committed', () => {
		expect(resolveClosetIndexStatus({ index_status: 'indexed', vector_indexed_at: null })).toBe(
			'committed'
		);
	});
});

describe('closet match lifecycle', () => {
	it('pending awaits the user', () => {
		expect(
			resolveMatchLifecycle(
				{ status: 'pending', resolved_closet_item_id: null },
				{ closetItemExists: false, wearLinked: false }
			)
		).toBe('pending');
		expect(nextActionForMatchLifecycle('pending', 'new')).toBe('await_user');
	});

	it('new without closet row or wear is claimed → resume_create', () => {
		expect(
			resolveMatchLifecycle(
				{ status: 'new', resolved_closet_item_id: 'reserved-1' },
				{ closetItemExists: false, wearLinked: false }
			)
		).toBe('claimed');
		expect(
			resolveMatchLifecycle(
				{ status: 'new', resolved_closet_item_id: 'reserved-1' },
				{ closetItemExists: true, wearLinked: false }
			)
		).toBe('claimed');
		expect(nextActionForMatchLifecycle('claimed', 'new')).toBe('resume_create');
	});

	it('new with tile and wear is done', () => {
		expect(
			resolveMatchLifecycle(
				{ status: 'new', resolved_closet_item_id: 'item-1' },
				{ closetItemExists: true, wearLinked: true }
			)
		).toBe('done');
		expect(nextActionForMatchLifecycle('done', 'new')).toBe('none');
	});

	it('same without wear is claimed → resume_link', () => {
		expect(
			resolveMatchLifecycle(
				{ status: 'same', resolved_closet_item_id: 'c1' },
				{ closetItemExists: true, wearLinked: false }
			)
		).toBe('claimed');
		expect(nextActionForMatchLifecycle('claimed', 'same')).toBe('resume_link');
		expect(
			resolveMatchLifecycle(
				{ status: 'same', resolved_closet_item_id: 'c1' },
				{ closetItemExists: true, wearLinked: true }
			)
		).toBe('done');
	});
});
