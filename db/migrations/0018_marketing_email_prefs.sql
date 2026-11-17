-- Marketing email preferences (superseded for storage shape by 0019 — columns moved to user_email_prefs).
-- Kept so existing environments that already ran 0018 can apply 0019 cleanly.
ALTER TABLE users ADD COLUMN marketing_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (marketing_opt_in IN (0, 1));
ALTER TABLE users ADD COLUMN marketing_opt_in_at INTEGER;
ALTER TABLE users ADD COLUMN marketing_unsubscribed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_marketing_opt_in
  ON users (marketing_opt_in);

-- Send log for lifecycle emails (ESP-agnostic)
CREATE TABLE IF NOT EXISTS email_sends (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  template_key TEXT NOT NULL,
  campaign_key TEXT,
  provider TEXT NOT NULL DEFAULT 'resend',
  provider_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed', 'bounced', 'complained')),
  sent_at INTEGER,
  opened_at INTEGER,
  clicked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_sends_user_template
  ON email_sends (user_id, template_key, campaign_key);

CREATE INDEX IF NOT EXISTS idx_email_sends_provider_message
  ON email_sends (provider_message_id);
