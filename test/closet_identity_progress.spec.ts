import { describe, expect, it } from 'vitest';
import type { ClosetIdentityJobCounts, ClosetIdentityProgressRow } from '../src/db/closet';
import {
	IDENTITY_PROGRESS_SETTLE_SECONDS,
	decideClosetIdentityProgress,
	inFlightIdentityJobs,
	isClosetIdentitySettleJob,
	runClosetIdentityProgress,
	scheduleClosetIdentitySettle,
} from '../src/services/identity/closetIdentityProgress';
import type { Logger } from '../src/utils/logger.utils';

const NOW = 1_700_000_000_000;
const SETTLE_MS = IDENTITY_PROGRESS_SETTLE_SECONDS * 1000;

describe('isClosetIdentitySettleJob', () => {
	it('matches settle jobs only', () => {
		expect(isClosetIdentitySettleJob({ kind: 'closet_identity_settle', userId: 'u1' })).toBe(true);
		expect(isClosetIdentitySettleJob({ kind: 'closet_identity' })).toBe(false);
		expect(isClosetIdentitySettleJob(undefined)).toBe(false);
	});
});

describe('inFlightIdentityJobs', () => {
	it('counts queued plus running and ignores done or failed', () => {
		expect(inFlightIdentityJobs({ queued: 2, running: 1, done: 9, failed: 4 })).toBe(3);
		expect(inFlightIdentityJobs({ queued: 0, running: 0, done: 3, failed: 2 })).toBe(0);
	});
});

describe('decideClosetIdentityProgress', () => {
	it('emits started once on idle to in-flight', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 2,
				lastActivityAt: NOW,
				lastStartedAt: null,
				lastSettledAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'started' });
	});

	it('stays silent while the same wave is still in flight', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 2,
				lastActivityAt: NOW,
				lastStartedAt: NOW - 5_000,
				lastSettledAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'silent' });
	});

	it('starts a new wave after a previous settle', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 1,
				lastActivityAt: NOW,
				lastStartedAt: NOW - 60_000,
				lastSettledAt: NOW - 30_000,
				nowMs: NOW,
			})
		).toEqual({ action: 'started' });
	});

	it('retries settle while the quiet window is still open', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 0,
				lastActivityAt: NOW - 5_000,
				lastStartedAt: NOW - 10_000,
				lastSettledAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'retry', delaySeconds: 15 });
	});

	it('settles once after in-flight stays at zero past the quiet window', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 0,
				lastActivityAt: NOW - SETTLE_MS,
				lastStartedAt: NOW - SETTLE_MS - 1_000,
				lastSettledAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'settled' });
	});

	it('skips a duplicate settle for the same activity', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 0,
				lastActivityAt: NOW - SETTLE_MS,
				lastStartedAt: NOW - SETTLE_MS - 1_000,
				lastSettledAt: NOW - 1_000,
				nowMs: NOW,
			})
		).toEqual({ action: 'skip', reason: 'already_settled' });
	});

	it('skips when there is no activity to settle', () => {
		expect(
			decideClosetIdentityProgress({
				inFlight: 0,
				lastActivityAt: null,
				lastStartedAt: null,
				lastSettledAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'skip', reason: 'idle' });
	});
});

describe('runClosetIdentityProgress', () => {
	it('broadcasts started once and does not schedule a settle job', async () => {
		const closet = memoryProgress({
			counts: { queued: 2, running: 0, done: 0, failed: 0 },
			state: { last_activity_at: NOW, last_started_at: null, last_settled_at: null },
		});
		const realtime = memoryRealtime();
		const queue = memoryQueue();

		const decision = await runClosetIdentityProgress({
			userId: 'u1',
			closet,
			realtime,
			log: silentLogger(),
			nowMs: NOW,
			queue,
			scheduleOnRetry: true,
		});

		expect(decision).toEqual({ action: 'started' });
		expect(closet.startedAt).toBe(NOW);
		expect(realtime.events).toEqual([
			{
				userId: 'u1',
				payload: { processing: true, queued: 2, running: 0, failed: 0, phase: 'started' },
			},
		]);
		expect(queue.sent).toHaveLength(0);
	});

	it('does not broadcast mid-batch', async () => {
		const closet = memoryProgress({
			counts: { queued: 1, running: 1, done: 1, failed: 0 },
			state: { last_activity_at: NOW, last_started_at: NOW - 1_000, last_settled_at: null },
		});
		const realtime = memoryRealtime();

		const decision = await runClosetIdentityProgress({
			userId: 'u1',
			closet,
			realtime,
			log: silentLogger(),
			nowMs: NOW,
		});

		expect(decision).toEqual({ action: 'silent' });
		expect(realtime.events).toHaveLength(0);
		expect(closet.startedAt).toBeNull();
		expect(closet.settledAt).toBeNull();
	});

	it('schedules a delayed settle job when in-flight just hit zero', async () => {
		const closet = memoryProgress({
			counts: { queued: 0, running: 0, done: 3, failed: 1 },
			state: { last_activity_at: NOW - 2_000, last_started_at: NOW - 10_000, last_settled_at: null },
		});
		const realtime = memoryRealtime();
		const queue = memoryQueue();

		const decision = await runClosetIdentityProgress({
			userId: 'u1',
			closet,
			realtime,
			log: silentLogger(),
			nowMs: NOW,
			queue,
			scheduleOnRetry: true,
		});

		expect(decision).toEqual({ action: 'retry', delaySeconds: 18 });
		expect(realtime.events).toHaveLength(0);
		expect(queue.sent).toEqual([
			{ job: { kind: 'closet_identity_settle', userId: 'u1' }, delaySeconds: 18 },
		]);
	});

	it('does not enqueue another settle when the settle consumer itself retries', async () => {
		const closet = memoryProgress({
			counts: { queued: 0, running: 0, done: 1, failed: 0 },
			state: { last_activity_at: NOW - 2_000, last_started_at: NOW - 10_000, last_settled_at: null },
		});
		const queue = memoryQueue();

		await runClosetIdentityProgress({
			userId: 'u1',
			closet,
			realtime: memoryRealtime(),
			log: silentLogger(),
			nowMs: NOW,
			queue,
			scheduleOnRetry: false,
		});

		expect(queue.sent).toHaveLength(0);
	});

	it('broadcasts settled once after the quiet window', async () => {
		const closet = memoryProgress({
			counts: { queued: 0, running: 0, done: 2, failed: 0 },
			state: {
				last_activity_at: NOW - SETTLE_MS,
				last_started_at: NOW - SETTLE_MS - 1_000,
				last_settled_at: null,
			},
		});
		const realtime = memoryRealtime();

		const decision = await runClosetIdentityProgress({
			userId: 'u1',
			closet,
			realtime,
			log: silentLogger(),
			nowMs: NOW,
		});

		expect(decision).toEqual({ action: 'settled' });
		expect(closet.settledAt).toBe(NOW);
		expect(realtime.events).toEqual([
			{
				userId: 'u1',
				payload: { processing: false, queued: 0, running: 0, failed: 0, phase: 'settled' },
			},
		]);
	});
});

describe('scheduleClosetIdentitySettle', () => {
	it('sends a settle job on the identity queue', async () => {
		const queue = memoryQueue();
		await scheduleClosetIdentitySettle(queue, 'u1', 20);
		expect(queue.sent).toEqual([
			{ job: { kind: 'closet_identity_settle', userId: 'u1' }, delaySeconds: 20 },
		]);
	});
});

function memoryProgress(opts: {
	counts: ClosetIdentityJobCounts;
	state: Omit<ClosetIdentityProgressRow, 'user_id'> | null;
}) {
	return {
		startedAt: null as number | null,
		settledAt: null as number | null,
		async countIdentityJobsByStatus() {
			return opts.counts;
		},
		async getIdentityProgressState(): Promise<ClosetIdentityProgressRow | null> {
			if (!opts.state) return null;
			return { user_id: 'u1', ...opts.state };
		},
		async markIdentityProgressStarted(_userId: string, atMs: number) {
			this.startedAt = atMs;
		},
		async markIdentityProgressSettled(_userId: string, atMs: number) {
			this.settledAt = atMs;
		},
	};
}

function memoryRealtime() {
	const events: Array<{
		userId: string;
		payload: {
			processing: boolean;
			queued: number;
			running: number;
			failed: number;
			phase: 'started' | 'settled';
		};
	}> = [];
	return {
		events,
		async notifyClosetIdentityUpdated(
			userId: string,
			payload: (typeof events)[number]['payload']
		) {
			events.push({ userId, payload });
		},
	};
}

function memoryQueue() {
	const sent: Array<{ job: { kind: string; userId: string }; delaySeconds?: number }> = [];
	return {
		sent,
		async send(job: { kind: string; userId: string }, opts?: { delaySeconds?: number }) {
			sent.push({ job, delaySeconds: opts?.delaySeconds });
		},
	};
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
