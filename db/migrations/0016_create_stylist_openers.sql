-- Stylist opener message pool (admin-editable, versioned for client cache)
CREATE TABLE IF NOT EXISTS stylist_opener_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stylist_opener_messages (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stylist_opener_messages_created
  ON stylist_opener_messages (created_at ASC);

-- Seed from Flutter UxMessages fallbacks (version 1)
INSERT INTO stylist_opener_meta (id, version, updated_at)
VALUES (1, 1, strftime('%s','now') * 1000);

INSERT INTO stylist_opener_messages (id, text, tags_json, created_at) VALUES
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Looking great! 🔥 What''s the occasion for this outfit?',
    '["with_image"]',
    strftime('%s','now') * 1000
  ),
  (
    'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    'Hey! I''m your stylist. Let''s get started on your vibe for today.',
    '["without_image"]',
    strftime('%s','now') * 1000
  ),
  (
    'c3d4e5f6-a7b8-9012-cdef-123456789012',
    'Whenever you''re ready, share your outfit and I''ll jump right in with some tips!',
    '["without_image"]',
    strftime('%s','now') * 1000
  );
