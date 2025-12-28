-- Add image_key column to style_analysis_histories
ALTER TABLE style_analysis_histories ADD COLUMN image_key TEXT;

-- Add image_key column to style_analysis_entries
ALTER TABLE style_analysis_entries ADD COLUMN image_key TEXT;