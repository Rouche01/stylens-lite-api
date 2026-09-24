import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDailyStyleNudgeDB } from '../src/db';
import {
	DAILY_STYLE_NUDGE_IGNORE_STREAK_CAP,
	effectiveIgnoreStreak,
} from '../src/db/daily_style_nudge';

const DAY_MS = 24 * 60 * 60 * 1000;

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
	`CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL,
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
	`CREATE TABLE IF NOT EXISTS daily_style_nudge_state (
  user_id TEXT PRIMARY KEY,
  last_notified_at INTEGER NOT NULL,
  ignore_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`,
];

async function seedUser(params: {
	id: string;
	authId: string;
	hasToken?: boolean;
	historyAts?: number[];
	notify?: { lastNotifiedAt: number; ignoreStreak: number };
	now: number;
}) {
	const stmts = [
		env.GOSTYLENS_DB.prepare(
			`INSERT OR REPLACE INTO users (id, auth_id, name, email, created_at, updated_at, is_active)
			 VALUES (?, ?, ?, ?, ?, ?, 1)`
		).bind(params.id, params.authId, params.id, `${params.id}@test.com`, params.now, params.now),
	];

	if (params.hasToken !== false) {
		stmts.push(
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO push_tokens (id, user_id, token, platform, created_at, updated_at)
				 VALUES (?, ?, ?, 'ios', ?, ?)`
			).bind(`tok-${params.id}`, params.id, `fcm-${params.id}`, params.now, params.now)
		);
	}

	for (const [i, at] of (params.historyAts ?? []).entries()) {
		stmts.push(
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO style_analysis_histories
				 (id, user_id, title, created_at, updated_at, is_deleted)
				 VALUES (?, ?, ?, ?, ?, 0)`
			).bind(`h-${params.id}-${i}`, params.id, 'Session', at, at)
		);
	}

	if (params.notify) {
		stmts.push(
			env.GOSTYLENS_DB.prepare(
				`INSERT OR REPLACE INTO daily_style_nudge_state
				 (user_id, last_notified_at, ignore_streak, updated_at)
				 VALUES (?, ?, ?, ?)`
			).bind(
				params.id,
				params.notify.lastNotifiedAt,
				params.notify.ignoreStreak,
				params.notify.lastNotifiedAt
			)
		);
	}

	await env.GOSTYLENS_DB.batch(stmts);
}

describe('effectiveIgnoreStreak', () => {
	it('resets when a session lands after the last nudge', () => {
		expect(
			effectiveIgnoreStreak({
				storedStreak: 2,
				lastNotifiedAt: 1000,
				latestSessionAt: 2000,
			})
		).toBe(0);
	});

	it('keeps stored streak when no session since last nudge', () => {
		expect(
			effectiveIgnoreStreak({
				storedStreak: 2,
				lastNotifiedAt: 2000,
				latestSessionAt: 1000,
			})
		).toBe(2);
	});

	it('is zero when never notified', () => {
		expect(
			effectiveIgnoreStreak({
				storedStreak: 3,
				lastNotifiedAt: null,
				latestSessionAt: 1000,
			})
		).toBe(0);
	});
});

describe('DailyStyleNudgeDB.listCandidates', () => {
	beforeAll(async () => {
		for (const sql of SETUP) {
			await env.GOSTYLENS_DB.prepare(sql).run();
		}
	});

	it('returns activated users with a token and no session today', async () => {
		const now = Date.UTC(2026, 8, 24, 8, 0, 0);
		const dayStart = Date.UTC(2026, 8, 24, 0, 0, 0);
		const yesterday = dayStart - DAY_MS / 2;

		await seedUser({
			id: 'u-eligible',
			authId: 'a-eligible',
			historyAts: [yesterday],
			now,
		});
		await seedUser({
			id: 'u-session-today',
			authId: 'a-today',
			historyAts: [yesterday, dayStart + 60_000],
			now,
		});
		await seedUser({
			id: 'u-first-today',
			authId: 'a-first',
			historyAts: [dayStart + 120_000],
			now,
		});
		await seedUser({
			id: 'u-no-token',
			authId: 'a-notoken',
			hasToken: false,
			historyAts: [yesterday],
			now,
		});
		await seedUser({
			id: 'u-never-styled',
			authId: 'a-nostyle',
			historyAts: [],
			now,
		});

		const db = createDailyStyleNudgeDB(env.GOSTYLENS_DB);
		const rows = await db.listCandidates({ dayStartMs: dayStart });
		const ids = rows.map((r) => r.user_id);

		expect(ids).toContain('u-eligible');
		expect(ids).not.toContain('u-session-today');
		expect(ids).not.toContain('u-first-today');
		expect(ids).not.toContain('u-no-token');
		expect(ids).not.toContain('u-never-styled');
	});

	it('skips users already notified today and those at the ignore cap', async () => {
		const now = Date.UTC(2026, 8, 25, 8, 0, 0);
		const dayStart = Date.UTC(2026, 8, 25, 0, 0, 0);
		const yesterday = dayStart - DAY_MS / 2;
		const twoDaysAgo = dayStart - 2 * DAY_MS;

		await seedUser({
			id: 'u-already',
			authId: 'a-already',
			historyAts: [twoDaysAgo],
			notify: { lastNotifiedAt: dayStart + 30_000, ignoreStreak: 1 },
			now,
		});
		await seedUser({
			id: 'u-capped',
			authId: 'a-capped',
			historyAts: [twoDaysAgo],
			notify: { lastNotifiedAt: yesterday, ignoreStreak: DAILY_STYLE_NUDGE_IGNORE_STREAK_CAP },
			now,
		});
		await seedUser({
			id: 'u-reset',
			authId: 'a-reset',
			historyAts: [twoDaysAgo, yesterday],
			notify: { lastNotifiedAt: twoDaysAgo, ignoreStreak: DAILY_STYLE_NUDGE_IGNORE_STREAK_CAP },
			now,
		});

		const db = createDailyStyleNudgeDB(env.GOSTYLENS_DB);
		const rows = await db.listCandidates({ dayStartMs: dayStart });
		const byId = Object.fromEntries(rows.map((r) => [r.user_id, r]));

		expect(byId['u-already']).toBeUndefined();
		expect(byId['u-capped']).toBeUndefined();
		expect(byId['u-reset']).toBeDefined();
		expect(byId['u-reset'].effective_ignore_streak).toBe(0);
	});

	it('markNotified upserts last_notified_at and ignore_streak', async () => {
		const now = Date.UTC(2026, 8, 26, 8, 30, 0);
		const dayStart = Date.UTC(2026, 8, 26, 0, 0, 0);
		const yesterday = dayStart - DAY_MS / 2;

		await seedUser({
			id: 'u-mark',
			authId: 'a-mark',
			historyAts: [yesterday],
			now,
		});

		const db = createDailyStyleNudgeDB(env.GOSTYLENS_DB);
		const before = await db.listCandidates({ dayStartMs: dayStart });
		const candidate = before.find((r) => r.user_id === 'u-mark');
		expect(candidate).toBeDefined();

		await db.markNotified({
			userId: 'u-mark',
			atMs: now,
			ignoreStreak: (candidate?.effective_ignore_streak ?? 0) + 1,
		});

		const state = await db.getState('u-mark');
		expect(state?.last_notified_at).toBe(now);
		expect(state?.ignore_streak).toBe(1);

		const after = await db.listCandidates({ dayStartMs: dayStart });
		expect(after.map((r) => r.user_id)).not.toContain('u-mark');
	});
});
