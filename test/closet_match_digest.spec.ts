import { describe, expect, it } from 'vitest';
import {
	closetMatchDigestNotification,
	decideClosetMatchDigest,
	runClosetMatchDigest,
} from '../src/services/identity/notify/digest';
import { isAvatarGenerationQueue, isClosetMatchDigestQueue } from '../src/queues';
import type { Logger } from '../src/utils/logger.utils';

const NOW = 1_700_000_000_000;
const SETTLE_MS = 600_000;

describe('closetMatchDigestNotification', () => {
	it('uses singular copy and string FCM data', () => {
		expect(closetMatchDigestNotification(1)).toEqual({
			title: 'Confirm your closet',
			body: 'You have 1 item to confirm',
			data: { type: 'closet_matches', count: '1' },
		});
	});

	it('uses plural copy for multiple items', () => {
		expect(closetMatchDigestNotification(3).body).toBe('You have 3 items to confirm');
		expect(closetMatchDigestNotification(3).data.count).toBe('3');
	});
});

describe('decideClosetMatchDigest', () => {
	it('skips when nothing is pending', () => {
		expect(
			decideClosetMatchDigest({
				pendingCount: 0,
				lastAskAt: NOW - SETTLE_MS,
				lastNotifiedAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'skip', reason: 'no_pending' });
	});

	it('retries when the latest ask is still inside the settle window', () => {
		expect(
			decideClosetMatchDigest({
				pendingCount: 2,
				lastAskAt: NOW - 120_000,
				lastNotifiedAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'retry', delaySeconds: 480 });
	});

	it('sends when pending asks have settled and this burst was not nudged', () => {
		expect(
			decideClosetMatchDigest({
				pendingCount: 2,
				lastAskAt: NOW - SETTLE_MS,
				lastNotifiedAt: null,
				nowMs: NOW,
			})
		).toEqual({ action: 'send' });
	});

	it('skips when this burst was already nudged', () => {
		expect(
			decideClosetMatchDigest({
				pendingCount: 2,
				lastAskAt: NOW - SETTLE_MS,
				lastNotifiedAt: NOW - 60_000,
				nowMs: NOW,
			})
		).toEqual({ action: 'skip', reason: 'already_nudged' });
	});

	it('sends again when a newer ask landed after the last nudge', () => {
		expect(
			decideClosetMatchDigest({
				pendingCount: 1,
				lastAskAt: NOW - SETTLE_MS,
				lastNotifiedAt: NOW - SETTLE_MS - 60_000,
				nowMs: NOW,
			})
		).toEqual({ action: 'send' });
	});
});

describe('isClosetMatchDigestQueue', () => {
	it('matches digest queue names', () => {
		expect(isClosetMatchDigestQueue('closet-match-digest')).toBe(true);
		expect(isClosetMatchDigestQueue('closet-match-digest-staging')).toBe(true);
		expect(isClosetMatchDigestQueue('avatar-generation')).toBe(false);
		expect(isAvatarGenerationQueue('avatar-generation')).toBe(true);
		expect(isAvatarGenerationQueue('avatar-generation-staging')).toBe(true);
		expect(isAvatarGenerationQueue('closet-match-digest')).toBe(false);
	});
});

describe('runClosetMatchDigest', () => {
	it('does not send when pending is empty', async () => {
		const push = { sends: [] as Array<{ title: string; data?: Record<string, string> }> };
		const closet = memoryNotify({ pendingCount: 0, lastAskAt: NOW - SETTLE_MS, lastNotifiedAt: null });

		const decision = await runClosetMatchDigest({
			userId: 'u1',
			closet,
			push: {
				sendPushNotification: async (_userId, title, _body, data) => {
					push.sends.push({ title, data });
					return { tokensFound: 1, tokensSent: 1, tokensFailed: 0, staleTokensRemoved: 0 };
				},
			},
			log: silentLogger(),
			nowMs: NOW,
		});

		expect(decision).toEqual({ action: 'skip', reason: 'no_pending' });
		expect(push.sends).toHaveLength(0);
		expect(closet.notifiedAt).toBeNull();
	});

	it('sends a digest and stamps last_notified_at', async () => {
		const push = { sends: [] as Array<{ title: string; body: string; data?: Record<string, string> }> };
		const closet = memoryNotify({ pendingCount: 3, lastAskAt: NOW - SETTLE_MS, lastNotifiedAt: null });

		const decision = await runClosetMatchDigest({
			userId: 'u1',
			closet,
			push: {
				sendPushNotification: async (_userId, title, body, data) => {
					push.sends.push({ title, body, data });
					return { tokensFound: 1, tokensSent: 1, tokensFailed: 0, staleTokensRemoved: 0 };
				},
			},
			log: silentLogger(),
			nowMs: NOW,
		});

		expect(decision).toEqual({ action: 'send' });
		expect(push.sends).toEqual([
			{
				title: 'Confirm your closet',
				body: 'You have 3 items to confirm',
				data: { type: 'closet_matches', count: '3' },
			},
		]);
		expect(closet.notifiedAt).toBe(NOW);
	});
});

function memoryNotify(state: {
	pendingCount: number;
	lastAskAt: number | null;
	lastNotifiedAt: number | null;
}) {
	return {
		countPendingMatches: async () => state.pendingCount,
		getMatchNotifyState: async () =>
			state.lastAskAt == null
				? null
				: { last_ask_at: state.lastAskAt, last_notified_at: state.lastNotifiedAt },
		markMatchNotified: async (_userId: string, atMs: number) => {
			state.lastNotifiedAt = atMs;
		},
		get notifiedAt() {
			return state.lastNotifiedAt;
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
