-- Create style_analysis_entry_tags (tags for style analysis entries)
CREATE TABLE IF NOT EXISTS style_analysis_entry_tags (
    id TEXT PRIMARY KEY,
    style_analysis_entry_id TEXT NOT NULL,
    tag TEXT CHECK(tag IN ('session_state:primary_outfit_image','session_state:alt_outfit_image','session_state:occasion', 'session_state:constraint', 'session_state:user_prefs', 'session_state:final_verdict')) NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (style_analysis_entry_id) REFERENCES style_analysis_entries(id) ON DELETE CASCADE
);

-- Improved Indexing for state retrieval and context development
-- 1. Covering index for looking up tags by specific entries
CREATE INDEX IF NOT EXISTS idx_style_analysis_entry_tags_lookup 
ON style_analysis_entry_tags(style_analysis_entry_id, tag);

-- 2. Global lookup for specific state tags across sessions
CREATE INDEX IF NOT EXISTS idx_style_analysis_entry_tags_tag_search 
ON style_analysis_entry_tags(tag, style_analysis_entry_id);
