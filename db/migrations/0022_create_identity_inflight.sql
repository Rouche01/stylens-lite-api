-- At most one identity create-commit job per user.
CREATE TABLE IF NOT EXISTS identity_inflight (
	user_id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
