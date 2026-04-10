-- Add payload JSON field to style_analysis_entry_tags
ALTER TABLE style_analysis_entry_tags ADD COLUMN payload TEXT;
