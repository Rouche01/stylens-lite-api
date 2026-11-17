-- Extend user_limits for trial / monthly overrides
ALTER TABLE user_limits ADD COLUMN trial_days INTEGER;
ALTER TABLE user_limits ADD COLUMN trial_session_limit INTEGER;
ALTER TABLE user_limits ADD COLUMN monthly_session_limit INTEGER;

-- Invite codes that seed user_limits overrides at signup
CREATE TABLE IF NOT EXISTS invite_codes (
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
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
