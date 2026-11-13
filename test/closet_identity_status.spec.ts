import { describe, expect, it } from 'vitest';
import {
	closetIdentityStatusPayload,
	identityJobsProcessing,
	identityWaveOpen,
} from '../src/db/closet';

describe('closetIdentityStatusPayload', () => {
	it('is processing when jobs are queued or running', () => {
		expect(
			closetIdentityStatusPayload({ queued: 1, running: 0, done: 4, failed: 0 })
		).toEqual({ processing: true, queued: 1, running: 0, failed: 0 });
		expect(
			closetIdentityStatusPayload({ queued: 0, running: 2, done: 0, failed: 1 })
		).toEqual({ processing: true, queued: 0, running: 2, failed: 1 });
	});

	it('is not processing when only done or failed remain and the wave settled', () => {
		expect(identityJobsProcessing({ queued: 0, running: 0, done: 3, failed: 2 })).toBe(false);
		expect(
			closetIdentityStatusPayload(
				{ queued: 0, running: 0, done: 3, failed: 2 },
				{ last_started_at: 100, last_settled_at: 200 }
			)
		).toEqual({ processing: false, queued: 0, running: 0, failed: 2 });
	});

	it('stays processing during the quiet settle window after jobs drain', () => {
		expect(
			closetIdentityStatusPayload(
				{ queued: 0, running: 0, done: 2, failed: 0 },
				{ last_started_at: 300, last_settled_at: 100 }
			)
		).toEqual({ processing: true, queued: 0, running: 0, failed: 0 });
		expect(
			closetIdentityStatusPayload(
				{ queued: 0, running: 0, done: 1, failed: 0 },
				{ last_started_at: 300, last_settled_at: null }
			)
		).toEqual({ processing: true, queued: 0, running: 0, failed: 0 });
	});
});

describe('identityWaveOpen', () => {
	it('is open after started and before settled', () => {
		expect(identityWaveOpen({ last_started_at: 10, last_settled_at: null })).toBe(true);
		expect(identityWaveOpen({ last_started_at: 20, last_settled_at: 10 })).toBe(true);
	});

	it('is closed when settled catches up or nothing started', () => {
		expect(identityWaveOpen(null)).toBe(false);
		expect(identityWaveOpen({ last_started_at: null, last_settled_at: null })).toBe(false);
		expect(identityWaveOpen({ last_started_at: 10, last_settled_at: 10 })).toBe(false);
		expect(identityWaveOpen({ last_started_at: 10, last_settled_at: 20 })).toBe(false);
	});
});
