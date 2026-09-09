import { createEmailSegmentsDB } from '../db/email_segments';
import { createEmailService } from '../services/email.svc';
import { buildUnsubscribeUrl } from '../utils/email_unsubscribe.utils';
import { isEnvFlagEnabled } from '../utils/env_flag.utils';
import { createLogger, Logger } from '../utils/logger.utils';
import { createPostHogSink } from '../services/posthog.svc';
import {
	filterByAllowlist,
	parseEmailAllowlist,
	shouldRestrictToAllowlist,
} from './email_allowlist';

export type ActivationD0JobResult = {
	candidates: number;
	eligible: number;
	sent: number;
	skipped: number;
	failed: number;
};

/**
 * Hourly (or on-demand) job: find activation_d0 segment → send via EmailService.
 * Gated by EMAIL_LIFECYCLE_CRON_ENABLED.
 */
export async function runActivationD0Job(
	env: Env,
	ctx: ExecutionContext,
	log?: Logger
): Promise<ActivationD0JobResult> {
	const sink = createPostHogSink(env);
	const logger = (
		log ??
		createLogger({
			env: env.ENV_NAME,
			sink,
			context: { job: 'activation_d0' },
		})
	).child({ job: 'activation_d0' });

	if (!isEnvFlagEnabled(env.EMAIL_LIFECYCLE_CRON_ENABLED)) {
		logger.info('activation_d0_skipped', { reason: 'cron_disabled' });
		sink?.flush(ctx);
		return { candidates: 0, eligible: 0, sent: 0, skipped: 0, failed: 0 };
	}

	const apiBase = env.EMAIL_API_BASE_URL?.trim();
	if (!apiBase) {
		logger.warn('activation_d0_skipped', { reason: 'missing_EMAIL_API_BASE_URL' });
		sink?.flush(ctx);
		return { candidates: 0, eligible: 0, sent: 0, skipped: 0, failed: 0 };
	}

	const segments = createEmailSegmentsDB(env.GOSTYLENS_DB);
	const candidates = await segments.listActivationD0Candidates();
	const allowlist = parseEmailAllowlist(env.EMAIL_SEND_ALLOWLIST);
	const restrict = shouldRestrictToAllowlist(env.ENV_NAME);
	const eligible = filterByAllowlist(candidates, allowlist, restrict);

	if (restrict && allowlist.size === 0) {
		logger.warn('activation_d0_skipped', {
			reason: 'empty_allowlist_dev_only',
			candidates: candidates.length,
		});
		sink?.flush(ctx);
		return {
			candidates: candidates.length,
			eligible: 0,
			sent: 0,
			skipped: 0,
			failed: 0,
		};
	}

	logger.info('activation_d0_batch_start', {
		candidates: candidates.length,
		eligible: eligible.length,
		allowlist_size: allowlist.size,
		restrict_allowlist: restrict,
	});

	const emailService = createEmailService(env, logger);
	const deepLinkUrl = env.EMAIL_APP_DEEP_LINK?.trim() || 'https://gostylens.app';

	let sent = 0;
	let skipped = 0;
	let failed = 0;

	for (const user of eligible) {
		try {
			const unsubscribeUrl = await buildUnsubscribeUrl({
				baseUrl: apiBase,
				userId: user.user_id,
				secret: env.EMAIL_UNSUBSCRIBE_SECRET,
			});

			const result = await emailService.sendLifecycleEmail({
				userId: user.user_id,
				templateKey: 'activation_d0',
				unsubscribeUrl,
				deepLinkUrl,
			});

			if (result.status === 'sent') {
				sent += 1;
			} else {
				skipped += 1;
				logger.info('activation_d0_user_skipped', {
					user_id: user.user_id,
					reason: result.reason,
				});
			}
		} catch (err) {
			failed += 1;
			logger.error(
				'activation_d0_user_failed',
				{ user_id: user.user_id },
				err
			);
		}
	}

	logger.info('activation_d0_batch_done', {
		candidates: candidates.length,
		eligible: eligible.length,
		sent,
		skipped,
		failed,
	});

	sink?.flush(ctx);
	return {
		candidates: candidates.length,
		eligible: eligible.length,
		sent,
		skipped,
		failed,
	};
}
