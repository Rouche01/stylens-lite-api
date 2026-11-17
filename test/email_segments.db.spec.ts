import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEmailSegmentsDB } from '../src/db';
import { ACTIVATION_D0_MIN_AGE_MS } from '../src/db/email_segments';

const SETUP = [
	`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gender TEXT,
  email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  is_active INTEGER DEFAULT 1
)`,
	`CREATE TABLE IF NOT EXISTS user_email_prefs (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  marketing_opt_in_at INTEGER,
  marketing_unsubscribed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS style_analysis_histories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  is_deleted INTEGER DEFAULT 0
)`,
	`CREATE TABLE IF NOT EXISTS style_analysis_entries (
  id TEXT PRIMARY KEY,
  style_analysis_history_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  image_url TEXT,
  created_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS email_sends (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  campaign_key TEXT,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL,
  sent_at INTEGER,
  opened_at INTEGER,
  clicked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
];

describe('EmailSegmentsDB.listActivationD0Candidates', () => {
	beforeAll(async () => {
		for (const sql of SETUP) {
			await env.GOSTYLENS_DB.prepare(sql).run();
		}
	});

	it('returns opted-in users past wait window with no assistant tip', async () => {
		const now = Date.now();
		const oldEnough = now - ACTIVATION_D0_MIN_AGE_MS - 60_000;
		const tooNew = now - 60_000;

		await env.GOSTYLENS_DB.batch([
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO users (id, auth_id, name, email, created_at, updated_at, is_active)
				 VALUES (?, ?, ?, ?, ?, ?, 1)`
			).bind('u-eligible', 'a1', 'Eligible', 'eligible@test.com', oldEnough, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO user_email_prefs
				 (id, user_id, marketing_opt_in, marketing_opt_in_at, marketing_unsubscribed_at, created_at, updated_at)
				 VALUES ('p1', 'u-eligible', 1, ?, NULL, ?, ?)`
			).bind(oldEnough, oldEnough, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO users (id, auth_id, name, email, created_at, updated_at, is_active)
				 VALUES (?, ?, ?, ?, ?, ?, 1)`
			).bind('u-new', 'a2', 'New', 'new@test.com', tooNew, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO user_email_prefs
				 (id, user_id, marketing_opt_in, marketing_opt_in_at, marketing_unsubscribed_at, created_at, updated_at)
				 VALUES ('p2', 'u-new', 1, ?, NULL, ?, ?)`
			).bind(tooNew, tooNew, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO users (id, auth_id, name, email, created_at, updated_at, is_active)
				 VALUES (?, ?, ?, ?, ?, ?, 1)`
			).bind('u-tipped', 'a3', 'Tipped', 'tipped@test.com', oldEnough, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO user_email_prefs
				 (id, user_id, marketing_opt_in, marketing_opt_in_at, marketing_unsubscribed_at, created_at, updated_at)
				 VALUES ('p3', 'u-tipped', 1, ?, NULL, ?, ?)`
			).bind(oldEnough, oldEnough, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO style_analysis_histories
				 (id, user_id, title, created_at, updated_at, is_deleted)
				 VALUES ('h1', 'u-tipped', 'Tip', ?, ?, 0)`
			).bind(oldEnough, now),
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO style_analysis_entries
				 (id, style_analysis_history_id, role, content, created_at)
				 VALUES ('e1', 'h1', 'assistant', 'Looks good', ?)`
			).bind(now),
		]);

		const segments = createEmailSegmentsDB(env.GOSTYLENS_DB);
		const rows = await segments.listActivationD0Candidates({ nowMs: now });
		const ids = rows.map((r) => r.user_id);

		expect(ids).toContain('u-eligible');
		expect(ids).not.toContain('u-new');
		expect(ids).not.toContain('u-tipped');
	});
});
