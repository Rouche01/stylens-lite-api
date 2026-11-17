/**
 * Free-tier limit resolution.
 *
 * Trial (first N days after signup): session cap from trial_session_limit (-1 = unlimited).
 * Post-trial: monthly session cap counted from UTC month start; resets each calendar month.
 * Message and image caps apply per session in both phases.
 *
 * Full behavior, examples, and API surface: docs/subscription-limits.md
 */
import { SubscriptionTier } from '../types';
import type { UserLimit } from '../db/types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type EffectiveLimits = {
	sessionCountLimit: number;
	messagePerSessionLimit: number;
	imagePerSessionLimit: number;
	inTrial: boolean;
	trialEndsAt: number | null;
	periodStart: number;
};

export type FreeTierEnvDefaults = {
	trialDays: number;
	trialSessionLimit: number;
	monthlySessionLimit: number;
	messagePerSessionLimit: number;
	imagePerSessionLimit: number;
};

export function parseEnvInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value === '') return fallback;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

export function startOfUtcMonth(ms: number): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function readFreeTierEnvDefaults(envVars: Record<string, any>): FreeTierEnvDefaults {
	return {
		trialDays: parseEnvInt(envVars.FREE_TIER_TRIAL_DAYS, 7),
		trialSessionLimit: parseEnvInt(envVars.FREE_TIER_TRIAL_SESSION_LIMIT, -1),
		monthlySessionLimit: parseEnvInt(envVars.FREE_TIER_MONTHLY_SESSION_LIMIT, 5),
		messagePerSessionLimit: parseEnvInt(envVars.FREE_TIER_MESSAGE_PER_SESSION_LIMIT, 20),
		imagePerSessionLimit: parseEnvInt(envVars.FREE_TIER_IMAGE_PER_SESSION_LIMIT, 10),
	};
}

/**
 * Resolves effective limits from tier, optional user_limits overrides, and env defaults.
 * Legacy session_count_limit is treated as monthly_session_limit when monthly_session_limit is null.
 */
export function resolveEffectiveLimits(params: {
	tier: SubscriptionTier;
	userCreatedAt: number;
	override: UserLimit | null;
	envDefaults: FreeTierEnvDefaults;
	now?: number;
}): EffectiveLimits {
	const { tier, userCreatedAt, override, envDefaults } = params;
	const now = params.now ?? Date.now();

	if (tier === SubscriptionTier.Core) {
		return {
			sessionCountLimit: -1,
			messagePerSessionLimit: -1,
			imagePerSessionLimit: -1,
			inTrial: false,
			trialEndsAt: null,
			periodStart: userCreatedAt,
		};
	}

	const trialDays = override?.trial_days ?? envDefaults.trialDays;
	const trialEndsAt = userCreatedAt + trialDays * MS_PER_DAY;
	const inTrial = now < trialEndsAt;

	const monthlyFromOverride =
		override?.monthly_session_limit ??
		(override?.session_count_limit !== undefined && override?.session_count_limit !== null
			? override.session_count_limit
			: null);

	let sessionCountLimit: number;
	let periodStart: number;

	if (inTrial) {
		sessionCountLimit = override?.trial_session_limit ?? envDefaults.trialSessionLimit;
		periodStart = userCreatedAt;
	} else {
		sessionCountLimit = monthlyFromOverride ?? envDefaults.monthlySessionLimit;
		periodStart = startOfUtcMonth(now);
	}

	const messagePerSessionLimit = override?.message_per_session_limit ?? envDefaults.messagePerSessionLimit;
	const imagePerSessionLimit = override?.image_per_session_limit ?? envDefaults.imagePerSessionLimit;

	return {
		sessionCountLimit,
		messagePerSessionLimit,
		imagePerSessionLimit,
		inTrial,
		trialEndsAt,
		periodStart,
	};
}
