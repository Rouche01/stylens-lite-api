-- Crop BlurHash for closet tiles (4×3, same as session images / Flutter encoder).
ALTER TABLE outfit_clothing_items ADD COLUMN blur_hash TEXT;
