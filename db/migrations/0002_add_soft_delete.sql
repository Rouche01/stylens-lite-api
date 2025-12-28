-- Add soft delete columns to style_analysis_histories
ALTER TABLE style_analysis_histories
  ADD COLUMN deleted_at INTEGER;

ALTER TABLE style_analysis_histories
  ADD COLUMN is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1));

-- Update the index to include is_deleted for better performance
DROP INDEX IF EXISTS idx_style_analysis_histories_user;

CREATE INDEX idx_style_analysis_histories_user
  ON style_analysis_histories (user_id, is_deleted, updated_at DESC);