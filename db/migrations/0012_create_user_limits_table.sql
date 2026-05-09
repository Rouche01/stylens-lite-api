-- Create user_limits table for fine-grained session control
CREATE TABLE IF NOT EXISTS user_limits (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    session_count_limit INTEGER, -- NULL: default, -1: unlimited, >0: specific limit
    message_per_session_limit INTEGER, -- NULL: default, -1: unlimited, >0: specific limit
    image_per_session_limit INTEGER, -- NULL: default, -1: unlimited, >0: specific limit
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_limits_user_id ON user_limits(user_id);
