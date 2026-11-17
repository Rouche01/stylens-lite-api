import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createStylistOpenersDB } from '../src/db';

const MIGRATION_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS stylist_opener_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS stylist_opener_messages (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS idx_stylist_opener_messages_created
  ON stylist_opener_messages (created_at ASC)`,
	`INSERT OR IGNORE INTO stylist_opener_meta (id, version, updated_at)
VALUES (1, 1, 1700000000000)`,
	`INSERT OR IGNORE INTO stylist_opener_messages (id, text, tags_json, created_at) VALUES
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Looking great! 🔥 What''s the occasion for this outfit?',
    '["with_image"]',
    1700000000000
  )`,
	`INSERT OR IGNORE INTO stylist_opener_messages (id, text, tags_json, created_at) VALUES
  (
    'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    'Hey! I''m your stylist. Let''s get started on your vibe for today.',
    '["without_image"]',
    1700000000000
  )`,
	`INSERT OR IGNORE INTO stylist_opener_messages (id, text, tags_json, created_at) VALUES
  (
    'c3d4e5f6-a7b8-9012-cdef-123456789012',
    'Whenever you''re ready, share your outfit and I''ll jump right in with some tips!',
    '["without_image"]',
    1700000000000
  )`,
];

describe('StylistOpenersDB', () => {
	beforeAll(async () => {
		for (const statement of MIGRATION_STATEMENTS) {
			await env.GOSTYLENS_DB.prepare(statement).run();
		}
	});

	it('returns seeded pool at version 1', async () => {
		const db = createStylistOpenersDB(env.GOSTYLENS_DB);
		const pool = await db.getPool();
		expect(pool.version).toBe(1);
		expect(pool.messages).toHaveLength(3);
		expect(pool.messages.some((m) => m.tags.includes('with_image'))).toBe(true);
		expect(pool.messages.filter((m) => m.tags.includes('without_image'))).toHaveLength(2);
	});

	it('replaces pool and bumps version', async () => {
		const db = createStylistOpenersDB(env.GOSTYLENS_DB);
		const updated = await db.replacePool([
			{
				id: 'new-with',
				text: 'Fresh look — what are we dressing for?',
				tags: ['with_image'],
			},
			{
				id: 'new-without',
				text: 'Send an outfit whenever you are ready.',
				tags: ['without_image'],
			},
		]);

		expect(updated.version).toBe(2);
		expect(updated.messages).toHaveLength(2);

		const pool = await db.getPool();
		expect(pool.version).toBe(2);
		expect(pool.messages.map((m) => m.id).sort()).toEqual(['new-with', 'new-without']);
	});
});
