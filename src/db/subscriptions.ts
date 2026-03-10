import { SubscriptionTier } from 'types';
import type { Subscription } from './types';

export type CreateSubscriptionParams = {
    userId: string;
    tier?: SubscriptionTier;
    provider?: string;
    providerCustomerId?: string;
    providerSubscriptionId?: string;
    status?: string;
    currentPeriodEnd?: number;
};

export class SubscriptionsDB {
    constructor(private db: D1Database) { }

    async createSubscription(params: CreateSubscriptionParams): Promise<Subscription> {
        const { userId, tier = SubscriptionTier.Free, provider, providerCustomerId, providerSubscriptionId, status, currentPeriodEnd } = params;
        const id = crypto.randomUUID();
        const now = Date.now();

        await this.db
            .prepare(
                `
        INSERT INTO subscriptions (id, user_id, tier, provider, provider_customer_id, provider_subscription_id, status, current_period_end, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .bind(id, userId, tier, provider ?? null, providerCustomerId ?? null, providerSubscriptionId ?? null, status ?? null, currentPeriodEnd ?? null, now, now)
            .run();

        const subscription = await this.getSubscriptionById(id);
        return subscription!;
    }

    async getSubscriptionById(id: string): Promise<Subscription | null> {
        const result = await this.db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).bind(id).first<Subscription>();
        return result || null;
    }

    async getSubscriptionByUserId(userId: string): Promise<Subscription | null> {
        const result = await this.db.prepare(`SELECT * FROM subscriptions WHERE user_id = ?`).bind(userId).first<Subscription>();
        return result || null;
    }

    async getSubscriptionByProviderCustomerId(customerId: string, provider: string = 'stripe'): Promise<Subscription | null> {
        const result = await this.db.prepare(`SELECT * FROM subscriptions WHERE provider_customer_id = ? AND provider = ?`).bind(customerId, provider).first<Subscription>();
        return result || null;
    }

    async getSubscriptionByProviderSubscriptionId(subscriptionId: string, provider: string = 'stripe'): Promise<Subscription | null> {
        const result = await this.db.prepare(`SELECT * FROM subscriptions WHERE provider_subscription_id = ? AND provider = ?`).bind(subscriptionId, provider).first<Subscription>();
        return result || null;
    }

    async updateSubscription(id: string, updates: Partial<Omit<Subscription, 'id' | 'user_id' | 'created_at'>>): Promise<Subscription | null> {
        const fields = [];
        const values = [];

        if (updates.tier !== undefined) {
            fields.push('tier = ?');
            values.push(updates.tier);
        }
        if (updates.provider !== undefined) {
            fields.push('provider = ?');
            values.push(updates.provider);
        }
        if (updates.provider_customer_id !== undefined) {
            fields.push('provider_customer_id = ?');
            values.push(updates.provider_customer_id);
        }
        if (updates.provider_subscription_id !== undefined) {
            fields.push('provider_subscription_id = ?');
            values.push(updates.provider_subscription_id);
        }
        if (updates.status !== undefined) {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (updates.current_period_end !== undefined) {
            fields.push('current_period_end = ?');
            values.push(updates.current_period_end);
        }

        if (updates.has_reached_limit !== undefined) {
            fields.push('has_reached_limit = ?');
            values.push(updates.has_reached_limit);
        }

        if (fields.length === 0) return this.getSubscriptionById(id);

        fields.push('updated_at = ?');
        values.push(Date.now());

        values.push(id);

        await this.db
            .prepare(`UPDATE subscriptions SET ${fields.join(', ')} WHERE id = ?`)
            .bind(...values)
            .run();

        return this.getSubscriptionById(id);
    }

    async updateSubscriptionByUserId(userId: string, updates: Partial<Omit<Subscription, 'id' | 'user_id' | 'created_at'>>): Promise<Subscription | null> {
        const fields = [];
        const values = [];

        if (updates.tier !== undefined) {
            fields.push('tier = ?');
            values.push(updates.tier);
        }
        if (updates.provider !== undefined) {
            fields.push('provider = ?');
            values.push(updates.provider);
        }
        if (updates.provider_customer_id !== undefined) {
            fields.push('provider_customer_id = ?');
            values.push(updates.provider_customer_id);
        }
        if (updates.provider_subscription_id !== undefined) {
            fields.push('provider_subscription_id = ?');
            values.push(updates.provider_subscription_id);
        }
        if (updates.status !== undefined) {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (updates.current_period_end !== undefined) {
            fields.push('current_period_end = ?');
            values.push(updates.current_period_end);
        }

        if (updates.has_reached_limit !== undefined) {
            fields.push('has_reached_limit = ?');
            values.push(updates.has_reached_limit);
        }

        if (fields.length === 0) return this.getSubscriptionByUserId(userId);

        fields.push('updated_at = ?');
        values.push(Date.now());

        values.push(userId);

        await this.db
            .prepare(`UPDATE subscriptions SET ${fields.join(', ')} WHERE user_id = ?`)
            .bind(...values)
            .run();

        return this.getSubscriptionByUserId(userId);
    }

    async deleteSubscriptionByUserId(userId: string): Promise<void> {
        await this.db.prepare(`DELETE FROM subscriptions WHERE user_id = ?`).bind(userId).run();
    }
}
