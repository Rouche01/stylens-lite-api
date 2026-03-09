DROP TABLE IF EXISTS subscriptions;

CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT UNIQUE NOT NULL,
    tier TEXT CHECK(tier IN ('free', 'core')) DEFAULT 'free' NOT NULL,
    provider TEXT,
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    status TEXT,
    current_period_end INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_customer_id ON subscriptions(provider_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_subscription_id ON subscriptions(provider_subscription_id);
