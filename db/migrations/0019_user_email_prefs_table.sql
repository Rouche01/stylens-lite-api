-- Move marketing prefs off users onto a 1:1 table (default = no row = opted out)
CREATE TABLE IF NOT EXISTS user_email_prefs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1)),
  marketing_opt_in_at INTEGER,
  marketing_unsubscribed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_email_prefs_opt_in
  ON user_email_prefs (marketing_opt_in);

-- Copy any non-default prefs from users (0018 columns) before dropping them
INSERT INTO user_email_prefs (
  id,
  user_id,
  marketing_opt_in,
  marketing_opt_in_at,
  marketing_unsubscribed_at,
  created_at,
  updated_at
)
SELECT
  lower(hex(randomblob(16))),
  u.id,
  u.marketing_opt_in,
  u.marketing_opt_in_at,
  u.marketing_unsubscribed_at,
  u.created_at,
  COALESCE(u.updated_at, u.created_at)
FROM users u
WHERE (u.marketing_opt_in = 1 OR u.marketing_unsubscribed_at IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM user_email_prefs p WHERE p.user_id = u.id
  );

DROP INDEX IF EXISTS idx_users_marketing_opt_in;

ALTER TABLE users DROP COLUMN marketing_opt_in;
ALTER TABLE users DROP COLUMN marketing_opt_in_at;
ALTER TABLE users DROP COLUMN marketing_unsubscribed_at;
