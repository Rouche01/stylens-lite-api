-- Widen closet_identity_jobs.status for in-app processing, and add a per-user
-- batch-progress row (digest-style start/settle, not per photo).
CREATE TABLE closet_identity_jobs_v2 (
	user_id TEXT NOT NULL,
	image_key TEXT NOT NULL,
	image_url TEXT NOT NULL,
	session_id TEXT,
	entry_id TEXT,
	source TEXT NOT NULL DEFAULT 'session',
	status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'failed')) DEFAULT 'queued',
	outfit_id TEXT,
	extraction_json TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, image_key),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO closet_identity_jobs_v2 (
	user_id, image_key, image_url, session_id, entry_id, source, status, outfit_id, extraction_json, created_at, updated_at
)
SELECT
	user_id, image_key, image_url, session_id, entry_id, source, status, outfit_id, extraction_json, created_at, updated_at
FROM closet_identity_jobs;

DROP TABLE closet_identity_jobs;

ALTER TABLE closet_identity_jobs_v2 RENAME TO closet_identity_jobs;

CREATE INDEX IF NOT EXISTS idx_closet_identity_jobs_status ON closet_identity_jobs(status);
CREATE INDEX IF NOT EXISTS idx_closet_identity_jobs_user_status ON closet_identity_jobs(user_id, status);

CREATE TABLE IF NOT EXISTS closet_identity_progress (
	user_id TEXT PRIMARY KEY,
	last_activity_at INTEGER NOT NULL,
	last_started_at INTEGER,
	last_settled_at INTEGER,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
