-- Cached identity probe on pending matches (upsert on resolve-new without Replicate).
-- resolved_closet_item_id is reserved at CAS time; no FK — the closet row may not exist yet.
-- vector_id / vector_indexed_at confirm Vectorize visibility on closet_items.
ALTER TABLE closet_item_matches ADD COLUMN probe_embed TEXT;
ALTER TABLE closet_item_matches ADD COLUMN resolved_closet_item_id TEXT;
ALTER TABLE closet_items ADD COLUMN vector_id TEXT;
ALTER TABLE closet_items ADD COLUMN vector_indexed_at INTEGER;
