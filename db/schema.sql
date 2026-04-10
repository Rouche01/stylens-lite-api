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

CREATE TABLE IF NOT EXISTS style_analysis_entry_images (
  id TEXT PRIMARY KEY,
  style_analysis_entry_id TEXT NOT NULL,
  url TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (style_analysis_entry_id) REFERENCES style_analysis_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_style_analysis_entry_images_history
  ON style_analysis_entry_images (style_analysis_entry_id, created_at ASC);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,           -- Local unique user ID (e.g., UUID)
  auth_id TEXT UNIQUE NOT NULL,  -- External Auth system user ID
  name TEXT NOT NULL,            -- User's name
  gender TEXT CHECK(
    gender IN ('male', 'female', 'non-binary', 'unspecified')
  ),                             -- Optional: enum
  email TEXT,                    -- Optional: for convenience
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1)),
  UNIQUE(email)
);

CREATE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id);

CREATE INDEX IF NOT EXISTS idx_style_analysis_histories_user
  ON style_analysis_histories (user_id, is_deleted, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_style_analysis_entries_history
  ON style_analysis_entries (style_analysis_history_id, created_at ASC);

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

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    tier TEXT CHECK(tier IN ('free', 'core')) DEFAULT 'free' NOT NULL,
    provider TEXT,
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    status TEXT,
    current_period_end INTEGER,
    has_reached_limit INTEGER DEFAULT 0 NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for looking up by provider customer id
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_customer_id ON subscriptions(provider_customer_id);

-- Index for looking up by provider subscription id
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_subscription_id ON subscriptions(provider_subscription_id);


-- Create style_analysis_entry_tags (tags for style analysis entries)
CREATE TABLE IF NOT EXISTS style_analysis_entry_tags (
    id TEXT PRIMARY KEY,
    style_analysis_entry_id TEXT NOT NULL,
    tag TEXT CHECK(tag IN ('session_state:primary_outfit_image','session_state:alt_outfit_image','session_state:occasion', 'session_state:constraint', 'session_state:user_prefs', 'session_state:final_verdict')) NOT NULL,
    payload TEXT, -- JSON metadata associated with the tag
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (style_analysis_entry_id) REFERENCES style_analysis_entries(id) ON DELETE CASCADE
);

-- Index for faster state lookup and context reconstruction
-- 1. Covering index for looking up tags by specific entries
CREATE INDEX IF NOT EXISTS idx_style_analysis_entry_tags_lookup 
ON style_analysis_entry_tags(style_analysis_entry_id, tag);

-- 2. Global lookup for specific state tags across sessions
CREATE INDEX IF NOT EXISTS idx_style_analysis_entry_tags_tag_search 
ON style_analysis_entry_tags(tag, style_analysis_entry_id);