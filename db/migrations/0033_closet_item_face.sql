-- Hybrid closet faces: gated SAM cutout + optional generative packshot (stored R2 keys).
-- face_source is derived on write; prefer flatlay > cutout > crop at read time.
ALTER TABLE closet_items ADD COLUMN cutout_image_key TEXT;
ALTER TABLE closet_items ADD COLUMN flatlay_image_key TEXT;
ALTER TABLE closet_items ADD COLUMN face_source TEXT NOT NULL DEFAULT 'crop';
ALTER TABLE closet_items ADD COLUMN face_updated_at INTEGER;
