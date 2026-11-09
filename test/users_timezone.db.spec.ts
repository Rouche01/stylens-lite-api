import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUsersDB } from '../src/db';

const SETUP = [
	`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gender TEXT,
  email TEXT,
  timezone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  is_active INTEGER DEFAULT 1
)`,
	`CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT,
  current_period_end INTEGER,
  has_reached_limit INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
];

describe('UsersDB timezone', () => {
	beforeAll(async () => {
		for (const sql of SETUP) {
			await env.GOSTYLENS_DB.prepare(sql).run();
		}
		const now = Date.now();
		await env.GOSTYLENS_DB.prepare(
			`INSERT OR REPLACE INTO users (id, auth_id, name, email, timezone, created_at, updated_at, is_active)
			 VALUES ('u-tz', 'a-tz', 'Tz', 'tz@test.com', NULL, ?, ?, 1)`
		)
			.bind(now, now)
			.run();
	});

	it('persists and clears timezone via updateUser', async () => {
		const users = createUsersDB(env.GOSTYLENS_DB);

		await users.updateUser('u-tz', { timezone: 'Europe/Amsterdam' });
		expect((await users.getUserById('u-tz'))?.timezone).toBe('Europe/Amsterdam');

		await users.updateUser('u-tz', { timezone: null });
		expect((await users.getUserById('u-tz'))?.timezone).toBeNull();
	});
});
