-- Encoder-pinned probe on closet items for index repair + unindexed ANN fallback.
ALTER TABLE closet_items ADD COLUMN probe_embed TEXT;
