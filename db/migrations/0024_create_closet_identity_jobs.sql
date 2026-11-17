-- Dedupes extract-identity queue jobs by photo so classification retries do not extract twice.
CREATE TABLE IF NOT EXISTS closet_identity_jobs (
	user_id TEXT NOT NULL,
	image_key TEXT NOT NULL,
	image_url TEXT NOT NULL,
	session_id TEXT,
	entry_id TEXT,
	source TEXT NOT NULL DEFAULT 'session',
	status TEXT NOT NULL CHECK(status IN ('queued', 'done')) DEFAULT 'queued',
	outfit_id TEXT,
	extraction_json TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, image_key),
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_closet_identity_jobs_status ON closet_identity_jobs(status);
