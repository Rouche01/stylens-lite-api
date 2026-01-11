CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- Local unique user ID (e.g., UUID)
  auth_id TEXT UNIQUE NOT NULL,  -- External Auth system user ID
  name TEXT NOT NULL,            -- User's name
  gender TEXT CHECK(
    gender IN ('male', 'female', 'non-binary', 'unspecified')
  ),                             -- Optional: enum
  email TEXT,                    -- Optional: for convenience
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
  UNIQUE(email)
);

CREATE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id);