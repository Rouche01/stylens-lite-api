-- 0003_add_image_url.sql
-- Add nullable image_url column to style_analysis_histories

ALTER TABLE style_analysis_histories
  ADD COLUMN image_url TEXT;