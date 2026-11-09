-- Oriented JPEG size at extract time. Used to compute closet tile aspect without fetching R2.
ALTER TABLE outfits ADD COLUMN image_width INTEGER;
ALTER TABLE outfits ADD COLUMN image_height INTEGER;
