CREATE TABLE IF NOT EXISTS style_analysis_histories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS style_analysis_entries (
  id TEXT PRIMARY KEY,
  style_analysis_history_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('user','assistant','system')) NOT NULL,

  -- either (or both) of these may be present
  content   TEXT,        -- nullable: message text
  image_url TEXT,        -- nullable: single image reference (URL to R2, etc.)

  created_at INTEGER NOT NULL,

  -- enforce: at least one of (content, image_url)
  CHECK ( (content IS NOT NULL AND length(content) > 0)
       OR (image_url IS NOT NULL AND length(image_url) > 0) ),

  FOREIGN KEY (style_analysis_history_id)
    REFERENCES style_analysis_histories(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_style_analysis_histories_user
  ON style_analysis_histories (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_style_analysis_entries_history
  ON style_analysis_entries (style_analysis_history_id, created_at ASC);