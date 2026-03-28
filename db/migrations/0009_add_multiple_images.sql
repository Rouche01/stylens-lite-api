-- Migration to support multiple images per style analysis entry
CREATE TABLE IF NOT EXISTS style_analysis_entry_images (
  id TEXT PRIMARY KEY,
  style_analysis_entry_id TEXT NOT NULL,
  url TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (style_analysis_entry_id) REFERENCES style_analysis_entries(id) ON DELETE CASCADE
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_style_analysis_entry_images_entry_id ON style_analysis_entry_images(style_analysis_entry_id);

-- Optional: Migrate existing images from style_analysis_entries to the new table
INSERT INTO style_analysis_entry_images (id, style_analysis_entry_id, url, key, created_at)
SELECT 
  'migrated_' || id, 
  id, 
  image_url, 
  image_key, 
  created_at 
FROM style_analysis_entries 
WHERE image_url IS NOT NULL;
