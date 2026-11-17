-- Pending closet identity asks. Wear rows stay off this table until the user resolves same/new.
CREATE TABLE IF NOT EXISTS closet_item_matches (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	outfit_id TEXT NOT NULL,
	candidate_closet_item_id TEXT NOT NULL,
	bounding_box TEXT NOT NULL,
	confidence TEXT CHECK(confidence IN ('high', 'medium', 'low')) DEFAULT 'medium',
	extract_snapshot TEXT NOT NULL,
	score REAL NOT NULL,
	cosine REAL,
	color_distance REAL,
	band TEXT NOT NULL CHECK(band IN ('ask')) DEFAULT 'ask',
	status TEXT NOT NULL CHECK(status IN ('pending', 'same', 'new')) DEFAULT 'pending',
	created_at INTEGER NOT NULL,
	resolved_at INTEGER,
	FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
	FOREIGN KEY (outfit_id) REFERENCES outfits(id) ON DELETE CASCADE,
	FOREIGN KEY (candidate_closet_item_id) REFERENCES closet_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_closet_item_matches_user_status ON closet_item_matches(user_id, status);
CREATE INDEX IF NOT EXISTS idx_closet_item_matches_outfit ON closet_item_matches(outfit_id);
