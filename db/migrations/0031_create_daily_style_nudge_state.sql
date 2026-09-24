-- Per-user cadence for the daily style nudge push (once/day + ignore streak).
CREATE TABLE IF NOT EXISTS daily_style_nudge_state (
	user_id TEXT PRIMARY KEY,
	last_notified_at INTEGER NOT NULL,
	ignore_streak INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
