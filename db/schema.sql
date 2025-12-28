CREATE TABLE IF NOT EXISTS style_analysis_histories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  image_url TEXT,       -- nullable: single image reference (URL to R2, etc.)
  image_key TEXT,       -- nullable: storage key for the image
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1))
);

CREATE TABLE IF NOT EXISTS style_analysis_entries (
  id TEXT PRIMARY KEY,
  style_analysis_history_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('user','assistant','system')) NOT NULL,

  -- either (or both) of these may be present
  content   TEXT,        -- nullable: message text
  image_url TEXT,        -- nullable: single image reference (URL to R2, etc.)
  image_key TEXT,        -- nullable: storage key for the image

  created_at INTEGER NOT NULL,

  -- enforce: at least one of (content, image_url)
  CHECK ( (content IS NOT NULL AND length(content) > 0)
       OR (image_url IS NOT NULL AND length(image_url) > 0) ),

  FOREIGN KEY (style_analysis_history_id)
    REFERENCES style_analysis_histories(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_style_analysis_histories_user
  ON style_analysis_histories (user_id, is_deleted, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_style_analysis_entries_history
  ON style_analysis_entries (style_analysis_history_id, created_at ASC);