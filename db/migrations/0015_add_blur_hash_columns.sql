-- Add BlurHash placeholders for style analysis images (client-generated, stored as metadata)
ALTER TABLE style_analysis_entry_images ADD COLUMN blur_hash TEXT;
ALTER TABLE style_analysis_histories ADD COLUMN image_blur_hash TEXT;
