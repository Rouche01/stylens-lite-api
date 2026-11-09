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
