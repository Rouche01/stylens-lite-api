-- Many-to-one: one user may have many avatar rows (rejected/failed history + regenerations).
-- At most one live avatar per user: is_active = 1 and status in ('pending', 'ready').
CREATE TABLE IF NOT EXISTS user_avatars (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_image_key TEXT NOT NULL,
  source_image_url TEXT,
  avatar_image_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'rejected_framing')),
  framing_confidence TEXT,
  model TEXT,
  error TEXT,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_avatars_user_id ON user_avatars(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_avatars_one_in_flight
  ON user_avatars(user_id)
  WHERE status IN ('pending', 'ready') AND is_active = 1;
