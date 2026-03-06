CREATE TABLE IF NOT EXISTS favourites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  
  -- Add a nullable foreign key for each entity type that can be favourited
  style_analysis_history_id TEXT,
  -- Example future entity:
  -- product_id TEXT,
  -- outfit_id TEXT,
  
  created_at INTEGER NOT NULL,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (style_analysis_history_id) REFERENCES style_analysis_histories(id) ON DELETE CASCADE
  
  -- As you add more entities, you can add them to this table and add a CHECK constraint 
  -- to ensure EXACTLY ONE of the foreign keys is populated per row.
  -- CHECK (
  --   (CASE WHEN style_analysis_history_id IS NOT NULL THEN 1 ELSE 0 END) +
  --   (CASE WHEN product_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  -- )
);

-- Ensure a user can only favourite a specific history session once
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_history_favourite 
ON favourites(user_id, style_analysis_history_id) 
WHERE style_analysis_history_id IS NOT NULL;

-- Index for quickly fetching all favourites for a user
CREATE INDEX IF NOT EXISTS idx_favourites_user_id ON favourites(user_id);
