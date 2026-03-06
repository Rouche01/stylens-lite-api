import { SubscriptionTier } from 'types';
import type { Subscription } from './types';

export type CreateSubscriptionParams = {
    userId: string;
    tier?: SubscriptionTier;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    status?: string;
    currentPeriodEnd?: number;
};

export class SubscriptionsDB {
    constructor(private db: D1Database) { }

    async createSubscription(params: CreateSubscriptionParams): Promise<Subscription> {
        const { userId, tier = SubscriptionTier.Free, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd } = params;
        const id = crypto.randomUUID();
        const now = Date.now();

        await this.db
            .prepare(
                `
        INSERT INTO subscriptions (id, user_id, tier, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
            )
            .bind(id, userId, tier, stripeCustomerId ?? null, stripeSubscriptionId ?? null, status ?? null, currentPeriodEnd ?? null, now, now)
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

    async getSubscriptionByStripeCustomerId(customerId: string): Promise<Subscription | null> {
        const result = await this.db.prepare(`SELECT * FROM subscriptions WHERE stripe_customer_id = ?`).bind(customerId).first<Subscription>();
        return result || null;
    }

    async getSubscriptionByStripeSubscriptionId(subscriptionId: string): Promise<Subscription | null> {
        const result = await this.db.prepare(`SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`).bind(subscriptionId).first<Subscription>();
        return result || null;
    }

    async updateSubscription(id: string, updates: Partial<Omit<Subscription, 'id' | 'user_id' | 'created_at'>>): Promise<Subscription | null> {
        const fields = [];
        const values = [];

        if (updates.tier !== undefined) {
            fields.push('tier = ?');
            values.push(updates.tier);
        }
        if (updates.stripe_customer_id !== undefined) {
            fields.push('stripe_customer_id = ?');
            values.push(updates.stripe_customer_id);
        }
        if (updates.stripe_subscription_id !== undefined) {
            fields.push('stripe_subscription_id = ?');
            values.push(updates.stripe_subscription_id);
        }
        if (updates.status !== undefined) {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (updates.current_period_end !== undefined) {
            fields.push('current_period_end = ?');
            values.push(updates.current_period_end);
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

    async deleteSubscriptionByUserId(userId: string): Promise<void> {
        await this.db.prepare(`DELETE FROM subscriptions WHERE user_id = ?`).bind(userId).run();
    }
}
