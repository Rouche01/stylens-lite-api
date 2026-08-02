CREATE TABLE IF NOT EXISTS style_analysis_histories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  image_url TEXT,       -- nullable: single image reference (URL to R2, etc.)
  image_key TEXT,       -- nullable: storage key for the image
  image_blur_hash TEXT, -- nullable: BlurHash for session cover placeholder
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
  blur_hash TEXT,       -- nullable: BlurHash placeholder for progressive loading
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

-- Create user_limits table for fine-grained session control
CREATE TABLE IF NOT EXISTS user_limits (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    session_count_limit INTEGER, -- NULL: default, -1: unlimited, >0: specific limit (legacy; treated as monthly when monthly_session_limit is null)
    message_per_session_limit INTEGER, -- NULL: default, -1: unlimited, >0: specific limit
    image_per_session_limit INTEGER, -- NULL: default, -1: unlimited, >0: specific limit
    trial_days INTEGER, -- NULL: env default
    trial_session_limit INTEGER, -- NULL: env default, -1: unlimited, >0: specific limit
    monthly_session_limit INTEGER, -- NULL: env default, -1: unlimited, >0: specific limit
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for quickly fetching limits for a user
CREATE INDEX IF NOT EXISTS idx_user_limits_user_id ON user_limits(user_id);

-- Invite codes that seed user_limits overrides at signup
CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    trial_days INTEGER,
    trial_session_limit INTEGER,
    monthly_session_limit INTEGER,
    message_per_session_limit INTEGER,
    image_per_session_limit INTEGER,
    max_redemptions INTEGER,
    redemption_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);


-- Create outfits table
CREATE TABLE IF NOT EXISTS outfits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    original_image_url TEXT NOT NULL,
    image_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outfits_user_id ON outfits(user_id);

-- Create closet_items table (unique clothes)
CREATE TABLE IF NOT EXISTS closet_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    color TEXT NOT NULL,
    pattern TEXT NOT NULL,
    style_tags TEXT, -- JSON array of strings
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_closet_items_user_id ON closet_items(user_id);

-- Create outfit_clothing_items join table
CREATE TABLE IF NOT EXISTS outfit_clothing_items (
    id TEXT PRIMARY KEY,
    outfit_id TEXT NOT NULL,
    closet_item_id TEXT NOT NULL,
    bounding_box TEXT NOT NULL, -- JSON coordinates: {"x", "y", "width", "height"}
    confidence TEXT CHECK(confidence IN ('high', 'medium', 'low')) DEFAULT 'medium',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (outfit_id) REFERENCES outfits(id) ON DELETE CASCADE,
    FOREIGN KEY (closet_item_id) REFERENCES closet_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_outfit_clothing_items_outfit ON outfit_clothing_items(outfit_id);
CREATE INDEX IF NOT EXISTS idx_outfit_clothing_items_closet ON outfit_clothing_items(closet_item_id);


-- Create push_tokens table for sending push notifications to users' devices
CREATE TABLE IF NOT EXISTS push_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  platform    TEXT CHECK(platform IN ('ios', 'android')) NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Index for fast token lookups/retrievals by user
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);


-- Stylist opener message pool (admin-editable, versioned for client cache)
CREATE TABLE IF NOT EXISTS stylist_opener_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stylist_opener_messages (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stylist_opener_messages_created
  ON stylist_opener_messages (created_at ASC);


-- Seed default stylist openers (matches Flutter UxMessages fallbacks)
INSERT OR IGNORE INTO stylist_opener_meta (id, version, updated_at)
VALUES (1, 1, strftime('%s','now') * 1000);

INSERT OR IGNORE INTO stylist_opener_messages (id, text, tags_json, created_at) VALUES
  (
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    'Looking great! 🔥 What''s the occasion for this outfit?',
    '["with_image"]',
    strftime('%s','now') * 1000
  ),
  (
    'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    'Hey! I''m your stylist. Let''s get started on your vibe for today.',
    '["without_image"]',
    strftime('%s','now') * 1000
  ),
  (
    'c3d4e5f6-a7b8-9012-cdef-123456789012',
    'Whenever you''re ready, share your outfit and I''ll jump right in with some tips!',
    '["without_image"]',
    strftime('%s','now') * 1000
  );
