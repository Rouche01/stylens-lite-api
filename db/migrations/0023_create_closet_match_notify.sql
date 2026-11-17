-- Per-user last ask / last digest nudge for closet match notifications.
CREATE TABLE IF NOT EXISTS closet_match_notify (
	user_id TEXT PRIMARY KEY,
	last_ask_at INTEGER NOT NULL,
	last_notified_at INTEGER,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
