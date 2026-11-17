-- Hybrid closet faces: gated SAM cutout + optional generative packshot (stored R2 keys).
-- face_source is derived on write (crop | cutout | flatlay); prefer flatlay > cutout > crop at read.
-- Bootstrap schema.sql also CHECK(face_source IN (...)); ALTER ADD cannot add that CHECK here.
ALTER TABLE closet_items ADD COLUMN cutout_image_key TEXT;
ALTER TABLE closet_items ADD COLUMN flatlay_image_key TEXT;
ALTER TABLE closet_items ADD COLUMN face_source TEXT NOT NULL DEFAULT 'crop';
ALTER TABLE closet_items ADD COLUMN face_updated_at INTEGER;
