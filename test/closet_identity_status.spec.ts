import { describe, expect, it } from 'vitest';
import { closetIdentityStatusPayload, identityJobsProcessing } from '../src/db/closet';

describe('closetIdentityStatusPayload', () => {
	it('is processing when jobs are queued or running', () => {
		expect(
			closetIdentityStatusPayload({ queued: 1, running: 0, done: 4, failed: 0 })
		).toEqual({ processing: true, queued: 1, running: 0, failed: 0 });
		expect(
			closetIdentityStatusPayload({ queued: 0, running: 2, done: 0, failed: 1 })
		).toEqual({ processing: true, queued: 0, running: 2, failed: 1 });
	});

	it('is not processing when only done or failed remain', () => {
		expect(identityJobsProcessing({ queued: 0, running: 0, done: 3, failed: 2 })).toBe(false);
		expect(
			closetIdentityStatusPayload({ queued: 0, running: 0, done: 3, failed: 2 })
		).toEqual({ processing: false, queued: 0, running: 0, failed: 2 });
	});
});
