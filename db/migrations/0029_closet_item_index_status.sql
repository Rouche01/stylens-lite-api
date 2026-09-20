-- Closet item Vectorize indexing status (D1-first identity).
-- committed → indexing → indexed | index_degraded
-- vector_indexed_at remains the searchable stamp; index_status distinguishes in-flight vs given up.
ALTER TABLE closet_items ADD COLUMN index_status TEXT;
ALTER TABLE closet_items ADD COLUMN index_attempts INTEGER NOT NULL DEFAULT 0;

UPDATE closet_items
SET index_status = 'indexed'
WHERE vector_indexed_at IS NOT NULL AND (index_status IS NULL OR index_status = '');

UPDATE closet_items
SET index_status = 'committed'
WHERE vector_indexed_at IS NULL AND (index_status IS NULL OR index_status = '');

CREATE INDEX IF NOT EXISTS idx_closet_items_index_status
ON closet_items(index_status)
WHERE index_status IS NOT NULL AND index_status != 'indexed';
