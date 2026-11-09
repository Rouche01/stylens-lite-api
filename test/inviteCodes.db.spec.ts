import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createInviteCodesDB, createStyleAnalysisDB, createUsersDB, createUserLimitsDB } from '../src/db';

const SETUP = [
	`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gender TEXT,
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
)`,
	`CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT,
  current_period_end INTEGER,
  has_reached_limit INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`,
	`CREATE TABLE IF NOT EXISTS user_limits (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  session_count_limit INTEGER,
  message_per_session_limit INTEGER,
  image_per_session_limit INTEGER,
  trial_days INTEGER,
  trial_session_limit INTEGER,
  monthly_session_limit INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`,
	`CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  trial_days INTEGER,
  trial_session_limit INTEGER,
  monthly_session_limit INTEGER,
  message_per_session_limit INTEGER,
  image_per_session_limit INTEGER,
  max_redemptions INTEGER,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS style_analysis_histories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  image_key TEXT,
  image_blur_hash TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
];

describe('Invite codes and period session counts', () => {
	beforeAll(async () => {
		for (const statement of SETUP) {
			await env.GOSTYLENS_DB.prepare(statement).run();
		}
	});

	it('creates and redeems an invite code into user_limits on signup', async () => {
		const inviteCodesDB = createInviteCodesDB(env.GOSTYLENS_DB);
		const usersDB = createUsersDB(env.GOSTYLENS_DB);
		const userLimitsDB = createUserLimitsDB(env.GOSTYLENS_DB);

		const invite = await inviteCodesDB.createInviteCode({
			code: 'summer50',
			trialDays: 14,
			monthlySessionLimit: 10,
			maxRedemptions: 2,
		});
		expect(invite.code).toBe('SUMMER50');
		expect(invite.redemption_count).toBe(0);

		const redeemable = await inviteCodesDB.getRedeemableCode('summer50');
		const user = await usersDB.createUser({
			authId: 'auth-invite-1',
			name: 'Invite User',
			inviteLimits: {
				trial_days: redeemable.trial_days,
				trial_session_limit: redeemable.trial_session_limit,
				monthly_session_limit: redeemable.monthly_session_limit,
				message_per_session_limit: redeemable.message_per_session_limit,
				image_per_session_limit: redeemable.image_per_session_limit,
			},
			inviteRedemption: { inviteId: redeemable.id },
		});

		const limits = await userLimitsDB.getUserLimit(user.id);
		expect(limits?.trial_days).toBe(14);
		expect(limits?.monthly_session_limit).toBe(10);

		const after = await inviteCodesDB.getByCode('SUMMER50');
		expect(after?.redemption_count).toBe(1);
	});

	it('rejects exhausted invite codes', async () => {
		const inviteCodesDB = createInviteCodesDB(env.GOSTYLENS_DB);
		const invite = await inviteCodesDB.createInviteCode({
			code: 'ONCE',
			maxRedemptions: 1,
		});

		await env.GOSTYLENS_DB
			.prepare(`UPDATE invite_codes SET redemption_count = 1 WHERE id = ?`)
			.bind(invite.id)
			.run();

		await expect(inviteCodesDB.getRedeemableCode('ONCE')).rejects.toThrow(
			'Invite code has reached its redemption limit'
		);
	});

	it('counts sessions since a period start', async () => {
		const styleAnalysisDB = createStyleAnalysisDB(env.GOSTYLENS_DB);
		const userId = 'user-period-1';
		const periodStart = Date.UTC(2026, 7, 1);

		await env.GOSTYLENS_DB
			.prepare(
				`INSERT INTO style_analysis_histories (id, user_id, title, is_deleted, created_at, updated_at)
				 VALUES (?, ?, 'old', 0, ?, ?)`
			)
			.bind('s1', userId, periodStart - 1000, periodStart - 1000)
			.run();
		await env.GOSTYLENS_DB
			.prepare(
				`INSERT INTO style_analysis_histories (id, user_id, title, is_deleted, created_at, updated_at)
				 VALUES (?, ?, 'in-period', 0, ?, ?)`
			)
			.bind('s2', userId, periodStart + 1000, periodStart + 1000)
			.run();
		await env.GOSTYLENS_DB
			.prepare(
				`INSERT INTO style_analysis_histories (id, user_id, title, is_deleted, created_at, updated_at)
				 VALUES (?, ?, 'deleted', 1, ?, ?)`
			)
			.bind('s3', userId, periodStart + 2000, periodStart + 2000)
			.run();

		// Soft-deleted sessions still consume quota
		expect(await styleAnalysisDB.countSessionsSince(userId, periodStart)).toBe(2);
		expect(await styleAnalysisDB.countTotalSessions(userId)).toBe(3);
		expect(await styleAnalysisDB.countActiveSessions(userId)).toBe(2);
	});
});
