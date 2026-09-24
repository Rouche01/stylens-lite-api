import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/posthog.svc', () => ({
	createPostHogSink: () => ({ flush: () => undefined }),
}));

vi.mock('../src/db/daily_style_nudge', () => ({
	createDailyStyleNudgeDB: vi.fn(),
}));

vi.mock('../src/services/push.svc', () => ({
	createPushService: vi.fn(),
}));

import { createDailyStyleNudgeDB } from '../src/db/daily_style_nudge';
import { createPushService } from '../src/services/push.svc';
import { runDailyStyleNudgeJob } from '../src/jobs/daily_style_nudge';

describe('runDailyStyleNudgeJob', () => {
	it('no-ops when cron flag is disabled', async () => {
		const env = {
			ENV_NAME: 'dev',
			DAILY_STYLE_NUDGE_CRON_ENABLED: 'false',
			EMAIL_SEND_ALLOWLIST: '',
			GOSTYLENS_DB: {},
			FCM_SERVICE_ACCOUNT_JSON: 'dummy',
		} as unknown as Env;

		const result = await runDailyStyleNudgeJob(env, {} as ExecutionContext);
		expect(result).toEqual({
			timezones_checked: 0,
			timezones_in_window: 0,
			candidates: 0,
			eligible: 0,
			sent: 0,
			skipped: 0,
			failed: 0,
		});
		expect(createDailyStyleNudgeDB).not.toHaveBeenCalled();
	});

	it('sends and marks notified for morning-window candidates', async () => {
		const listDistinctPushTimezones = vi.fn().mockResolvedValue(['UTC']);
		const listCandidates = vi.fn().mockResolvedValue([
			{
				user_id: 'u1',
				email: 'a@test.com',
				timezone: 'UTC',
				last_notified_at: null,
				ignore_streak: 0,
				effective_ignore_streak: 0,
				latest_session_at: 1,
			},
		]);
		const markNotified = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createDailyStyleNudgeDB).mockReturnValue({
			listDistinctPushTimezones,
			listCandidates,
			markNotified,
		} as never);

		const sendPushNotification = vi.fn().mockResolvedValue({
			tokensFound: 1,
			tokensSent: 1,
			tokensFailed: 0,
			staleTokensRemoved: 0,
		});
		vi.mocked(createPushService).mockReturnValue({ sendPushNotification } as never);

		const env = {
			ENV_NAME: 'staging',
			DAILY_STYLE_NUDGE_CRON_ENABLED: 'true',
			EMAIL_SEND_ALLOWLIST: '',
			GOSTYLENS_DB: {},
			FCM_SERVICE_ACCOUNT_JSON: '{}',
		} as unknown as Env;

		const nowMs = Date.UTC(2026, 8, 24, 8, 5, 0);
		const result = await runDailyStyleNudgeJob(env, {} as ExecutionContext, undefined, nowMs);

		expect(result.timezones_in_window).toBe(1);
		expect(result.sent).toBe(1);
		expect(sendPushNotification).toHaveBeenCalledWith(
			'u1',
			expect.any(String),
			expect.any(String),
			expect.objectContaining({ type: 'daily_style_nudge', link: 'gostylens://capture' })
		);
		expect(markNotified).toHaveBeenCalledWith({
			userId: 'u1',
			atMs: nowMs,
			ignoreStreak: 1,
		});
	});
});
