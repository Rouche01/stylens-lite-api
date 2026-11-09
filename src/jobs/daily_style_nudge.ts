import { createDailyStyleNudgeDB } from '../db/daily_style_nudge';
import { createPushService } from '../services/push.svc';
import { createPostHogSink } from '../services/posthog.svc';
import { isEnvFlagEnabled } from '../utils/env_flag.utils';
import { createLogger, Logger } from '../utils/logger.utils';
import {
	isLocalMorningWindow,
	isValidIanaTimeZone,
	localDayStartMs,
} from '../utils/timezone.utils';
import {
	filterByAllowlist,
	parseEmailAllowlist,
	shouldRestrictToAllowlist,
} from './email_allowlist';

export type DailyStyleNudgeJobResult = {
	timezones_checked: number;
	timezones_in_window: number;
	candidates: number;
	eligible: number;
	sent: number;
	skipped: number;
	failed: number;
};

export type DailyStyleNudgeCopy = {
	title: string;
	body: string;
};

const COPY_VARIANTS: DailyStyleNudgeCopy[] = [
	{ title: 'Your stylist', body: 'What are you wearing today?' },
	{ title: 'Quick check-in', body: "Show me what you're wearing." },
	{ title: 'GoStylens', body: "Got an outfit on? Let's take a look." },
];

export const DAILY_STYLE_NUDGE_LINK = 'gostylens://capture';

/** Stable per-user / per-local-day variant pick (not an A/B experiment). */
export function pickDailyStyleNudgeCopy(userId: string, dayStartMs: number): DailyStyleNudgeCopy {
	let hash = 0;
	const key = `${userId}:${dayStartMs}`;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
	}
	return COPY_VARIANTS[hash % COPY_VARIANTS.length]!;
}

export function dailyStyleNudgePayload(copy: DailyStyleNudgeCopy): {
	title: string;
	body: string;
	data: Record<string, string>;
} {
	return {
		title: copy.title,
		body: copy.body,
		data: {
			type: 'daily_style_nudge',
			link: DAILY_STYLE_NUDGE_LINK,
		},
	};
}

/**
 * Hourly job: morning-window daily style nudge via PushService.
 * Gated by DAILY_STYLE_NUDGE_CRON_ENABLED.
 */
export async function runDailyStyleNudgeJob(
	env: Env,
	ctx: ExecutionContext,
	log?: Logger,
	nowMs = Date.now()
): Promise<DailyStyleNudgeJobResult> {
	const sink = createPostHogSink(env);
	const logger = (
		log ??
		createLogger({
			env: env.ENV_NAME,
			sink,
			context: { job: 'daily_style_nudge' },
		})
	).child({ job: 'daily_style_nudge' });

	const empty: DailyStyleNudgeJobResult = {
		timezones_checked: 0,
		timezones_in_window: 0,
		candidates: 0,
		eligible: 0,
		sent: 0,
		skipped: 0,
		failed: 0,
	};

	if (!isEnvFlagEnabled(env.DAILY_STYLE_NUDGE_CRON_ENABLED)) {
		logger.info('daily_style_nudge_skipped', { reason: 'cron_disabled' });
		sink?.flush(ctx);
		return empty;
	}

	const nudgeDb = createDailyStyleNudgeDB(env.GOSTYLENS_DB);
	const zones = await nudgeDb.listDistinctPushTimezones();
	const morningZones = zones.filter((tz) => {
		if (!isValidIanaTimeZone(tz)) return false;
		return isLocalMorningWindow(nowMs, tz);
	});

	if (morningZones.length === 0) {
		logger.info('daily_style_nudge_skipped', {
			reason: 'no_timezone_in_morning_window',
			timezones_checked: zones.length,
		});
		sink?.flush(ctx);
		return { ...empty, timezones_checked: zones.length };
	}

	const allowlist = parseEmailAllowlist(env.EMAIL_SEND_ALLOWLIST);
	const restrict = shouldRestrictToAllowlist(env.ENV_NAME);

	if (restrict && allowlist.size === 0) {
		logger.warn('daily_style_nudge_skipped', {
			reason: 'empty_allowlist_dev_only',
			timezones_in_window: morningZones.length,
		});
		sink?.flush(ctx);
		return {
			...empty,
			timezones_checked: zones.length,
			timezones_in_window: morningZones.length,
		};
	}

	logger.info('daily_style_nudge_batch_start', {
		timezones_checked: zones.length,
		timezones_in_window: morningZones.length,
		allowlist_size: allowlist.size,
		restrict_allowlist: restrict,
	});

	const push = createPushService(env, logger);
	let candidates = 0;
	let eligible = 0;
	let sent = 0;
	let skipped = 0;
	let failed = 0;

	for (const timezone of morningZones) {
		const dayStartMs = localDayStartMs(nowMs, timezone);
		const rows = await nudgeDb.listCandidates({ dayStartMs, timezone });
		candidates += rows.length;

		const withEmail = rows.map((r) => ({
			...r,
			email: (r.email ?? '').trim(),
		}));
		const batch = filterByAllowlist(withEmail, allowlist, restrict);
		eligible += batch.length;

		for (const user of batch) {
			const copy = pickDailyStyleNudgeCopy(user.user_id, dayStartMs);
			const payload = dailyStyleNudgePayload(copy);
			try {
				const result = await push.sendPushNotification(
					user.user_id,
					payload.title,
					payload.body,
					payload.data
				);
				if (result.tokensSent <= 0) {
					skipped += 1;
					logger.info('daily_style_nudge_user_skipped', {
						user_id: user.user_id,
						timezone,
						reason: result.tokensFound === 0 ? 'no_tokens' : 'send_failed',
						tokens_found: result.tokensFound,
						tokens_failed: result.tokensFailed,
					});
					continue;
				}

				await nudgeDb.markNotified({
					userId: user.user_id,
					atMs: nowMs,
					ignoreStreak: user.effective_ignore_streak + 1,
				});
				sent += 1;
				logger.info('daily_style_nudge_user_sent', {
					user_id: user.user_id,
					timezone,
					ignore_streak: user.effective_ignore_streak + 1,
					tokens_sent: result.tokensSent,
				});
			} catch (err) {
				failed += 1;
				logger.error('daily_style_nudge_user_failed', { user_id: user.user_id, timezone }, err);
			}
		}
	}

	logger.info('daily_style_nudge_batch_done', {
		timezones_checked: zones.length,
		timezones_in_window: morningZones.length,
		candidates,
		eligible,
		sent,
		skipped,
		failed,
	});

	sink?.flush(ctx);
	return {
		timezones_checked: zones.length,
		timezones_in_window: morningZones.length,
		candidates,
		eligible,
		sent,
		skipped,
		failed,
	};
}
