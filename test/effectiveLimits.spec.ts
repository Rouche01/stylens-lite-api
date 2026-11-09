import { describe, expect, it } from 'vitest';
import { SubscriptionTier } from '../src/types';
import type { UserLimit } from '../src/db/types';
import {
	parseEnvInt,
	readFreeTierEnvDefaults,
	resolveEffectiveLimits,
	startOfUtcMonth,
} from '../src/utils/effectiveLimits';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const defaultEnv = {
	trialDays: 7,
	trialSessionLimit: -1,
	monthlySessionLimit: 5,
	messagePerSessionLimit: 20,
	imagePerSessionLimit: 10,
};

function makeOverride(partial: Partial<UserLimit>): UserLimit {
	return {
		id: 'limit-1',
		user_id: 'user-1',
		session_count_limit: null,
		message_per_session_limit: null,
		image_per_session_limit: null,
		trial_days: null,
		trial_session_limit: null,
		monthly_session_limit: null,
		created_at: 0,
		updated_at: 0,
		...partial,
	};
}

describe('effectiveLimits helpers', () => {
	it('parseEnvInt falls back on missing or invalid values', () => {
		expect(parseEnvInt(undefined, 7)).toBe(7);
		expect(parseEnvInt('', 7)).toBe(7);
		expect(parseEnvInt('abc', 7)).toBe(7);
		expect(parseEnvInt('-1', 0)).toBe(-1);
		expect(parseEnvInt('5', 0)).toBe(5);
	});

	it('startOfUtcMonth returns the UTC month boundary', () => {
		expect(startOfUtcMonth(Date.UTC(2026, 7, 15, 12, 0, 0))).toBe(Date.UTC(2026, 7, 1));
	});

	it('readFreeTierEnvDefaults uses plan defaults', () => {
		expect(readFreeTierEnvDefaults({})).toEqual(defaultEnv);
		expect(readFreeTierEnvDefaults({ FREE_TIER_MONTHLY_SESSION_LIMIT: '10' }).monthlySessionLimit).toBe(10);
	});
});

describe('resolveEffectiveLimits', () => {
	const createdAt = Date.UTC(2026, 7, 1, 0, 0, 0); // Aug 1 2026

	it('returns unlimited for Core', () => {
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Core,
			userCreatedAt: createdAt,
			override: null,
			envDefaults: defaultEnv,
			now: createdAt + MS_PER_DAY,
		});
		expect(result).toEqual({
			sessionCountLimit: -1,
			messagePerSessionLimit: -1,
			imagePerSessionLimit: -1,
			inTrial: false,
			trialEndsAt: null,
			periodStart: createdAt,
		});
	});

	it('uses trial session limit during trial window', () => {
		const now = createdAt + 3 * MS_PER_DAY;
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: createdAt,
			override: null,
			envDefaults: defaultEnv,
			now,
		});
		expect(result.inTrial).toBe(true);
		expect(result.sessionCountLimit).toBe(-1);
		expect(result.periodStart).toBe(createdAt);
		expect(result.trialEndsAt).toBe(createdAt + 7 * MS_PER_DAY);
		expect(result.messagePerSessionLimit).toBe(20);
		expect(result.imagePerSessionLimit).toBe(10);
	});

	it('uses monthly session limit after trial with UTC month periodStart', () => {
		const now = createdAt + 10 * MS_PER_DAY; // Aug 11 — past 7-day trial
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: createdAt,
			override: null,
			envDefaults: defaultEnv,
			now,
		});
		expect(result.inTrial).toBe(false);
		expect(result.sessionCountLimit).toBe(5);
		expect(result.periodStart).toBe(Date.UTC(2026, 7, 1));
	});

	it('applies user_limits overrides including legacy session_count_limit as monthly', () => {
		const now = createdAt + 10 * MS_PER_DAY;
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: createdAt,
			override: makeOverride({
				session_count_limit: 12,
				message_per_session_limit: 50,
				image_per_session_limit: 3,
				trial_days: 14,
			}),
			envDefaults: defaultEnv,
			now,
		});
		// Still post-trial relative to 14-day override? createdAt+10 < createdAt+14, so still in trial
		expect(result.inTrial).toBe(true);
		expect(result.trialEndsAt).toBe(createdAt + 14 * MS_PER_DAY);

		const postTrial = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: createdAt,
			override: makeOverride({ session_count_limit: 12 }),
			envDefaults: defaultEnv,
			now: createdAt + 20 * MS_PER_DAY,
		});
		expect(postTrial.inTrial).toBe(false);
		expect(postTrial.sessionCountLimit).toBe(12);
	});

	it('prefers monthly_session_limit over legacy session_count_limit', () => {
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: createdAt,
			override: makeOverride({
				session_count_limit: 99,
				monthly_session_limit: 8,
			}),
			envDefaults: defaultEnv,
			now: createdAt + 20 * MS_PER_DAY,
		});
		expect(result.sessionCountLimit).toBe(8);
	});

	it('uses trial_session_limit override during trial', () => {
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: createdAt,
			override: makeOverride({ trial_session_limit: 2 }),
			envDefaults: defaultEnv,
			now: createdAt + MS_PER_DAY,
		});
		expect(result.inTrial).toBe(true);
		expect(result.sessionCountLimit).toBe(2);
	});
});

/**
 * Executable scenarios from docs/subscription-limits.md.
 * These document product behavior; countSessionsSince() applies periodStart when enforcing.
 */
describe('documented free-tier scenarios', () => {
	const signupJan5 = Date.UTC(2026, 0, 5, 0, 0, 0);

	it('during trial: unlimited sessions by default, counted from signup', () => {
		const duringTrial = Date.UTC(2026, 0, 8);
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: signupJan5,
			override: null,
			envDefaults: defaultEnv,
			now: duringTrial,
		});
		expect(result.inTrial).toBe(true);
		expect(result.sessionCountLimit).toBe(-1);
		expect(result.periodStart).toBe(signupJan5);
	});

	it('after trial mid-month: monthly cap with periodStart at UTC month start (trial sessions in same month count toward cap)', () => {
		const afterTrial = Date.UTC(2026, 0, 12);
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: signupJan5,
			override: null,
			envDefaults: defaultEnv,
			now: afterTrial,
		});
		expect(result.inTrial).toBe(false);
		expect(result.sessionCountLimit).toBe(5);
		expect(result.periodStart).toBe(Date.UTC(2026, 0, 1));
	});

	it('month rollover: new UTC month resets the counting window', () => {
		const feb1 = Date.UTC(2026, 1, 1);
		const result = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: signupJan5,
			override: null,
			envDefaults: defaultEnv,
			now: feb1,
		});
		expect(result.inTrial).toBe(false);
		expect(result.sessionCountLimit).toBe(5);
		expect(result.periodStart).toBe(Date.UTC(2026, 1, 1));
	});

	it('invite-code override: custom trial and monthly caps replace env defaults', () => {
		const inviteOverride = makeOverride({
			trial_days: 14,
			trial_session_limit: 3,
			monthly_session_limit: 10,
			message_per_session_limit: 50,
			image_per_session_limit: 5,
		});

		const duringTrial = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: signupJan5,
			override: inviteOverride,
			envDefaults: defaultEnv,
			now: signupJan5 + MS_PER_DAY,
		});
		expect(duringTrial.inTrial).toBe(true);
		expect(duringTrial.sessionCountLimit).toBe(3);
		expect(duringTrial.messagePerSessionLimit).toBe(50);
		expect(duringTrial.imagePerSessionLimit).toBe(5);

		const postTrial = resolveEffectiveLimits({
			tier: SubscriptionTier.Free,
			userCreatedAt: signupJan5,
			override: inviteOverride,
			envDefaults: defaultEnv,
			now: signupJan5 + 15 * MS_PER_DAY,
		});
		expect(postTrial.inTrial).toBe(false);
		expect(postTrial.sessionCountLimit).toBe(10);
		expect(postTrial.messagePerSessionLimit).toBe(50);
	});
});
