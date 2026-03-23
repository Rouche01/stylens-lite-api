import { error } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createSubscriptionsDB, createUsersDB } from 'db';
import { SubscriptionTier } from 'types';
import { verifyTimingSafe } from 'utils/crypto';

// RevenueCat Webhook Payload Type (Subset)
type RevenueCatEvent = {
    app_user_id: string;
    type: 'INITIAL_PURCHASE' | 'RENEWAL' | 'CANCELLATION' | 'EXPIRATION' | 'BILLING_ISSUE' | 'PRODUCT_CHANGE' | 'TRANSFER';
    entitlement_ids: string[] | null;
    expiration_at_ms: number | null;
    store: string;
    period_type: 'NORMAL' | 'TRIAL' | 'INTRO';
    original_app_user_id: string;
    original_transaction_id: string;
};

type RevenueCatWebhookBody = {
    api_version: string;
    event: RevenueCatEvent;
};

const revenueCatWebhookHandler = async (request: Request) => {
    try {
        const authHeader = request.headers.get('Authorization');
        const webhookSecret = env.REVENUECAT_WEBHOOK_SECRET;

        if (webhookSecret) {
            if (!authHeader || !verifyTimingSafe(authHeader, `Bearer ${webhookSecret}`)) {
                return error(401, 'Unauthorized: Invalid webhook secret');
            }
        }

        const { event } = (await request.json()) as RevenueCatWebhookBody;
        const userId = event.app_user_id;

        if (!userId) {
            return error(400, 'app_user_id is missing from event');
        }

        const userDB = createUsersDB(env.gostylens_db);
        const user = await userDB.getUserById(userId);

        if (!user) {
            return error(404, 'User not found');
        }

        const subscriptionsDB = createSubscriptionsDB(env.gostylens_db);
        const existingSubscription = await subscriptionsDB.getSubscriptionByUserId(userId);

        // Map entitlements to our internal tiers
        const hasCoreEntitlement = event.entitlement_ids ? event.entitlement_ids.includes('gostylens_core') : false;

        // Determine based on event type
        let targetTier = hasCoreEntitlement ? SubscriptionTier.Core : SubscriptionTier.Free;
        let status = 'active';
        let hasReachedLimit = 0;


        if (event.type === 'CANCELLATION' || event.type === 'EXPIRATION') {
            if (event.type === 'CANCELLATION') status = 'cancelled';
            if (event.type === 'EXPIRATION') {
                status = 'expired'
                targetTier = SubscriptionTier.Free
                hasReachedLimit = 1
            };
        }

        if (event.type === 'INITIAL_PURCHASE' || event.type === 'RENEWAL') {
            status = 'active';
            hasReachedLimit = 0;
        }

        const currentPeriodEnd = event.expiration_at_ms ? Math.floor(event.expiration_at_ms / 1000) : undefined;

        if (existingSubscription) {

            const updates: any = {
                tier: targetTier,
                provider: 'revenuecat',
                status: status,
                current_period_end: currentPeriodEnd,
                provider_customer_id: event.original_app_user_id,
                provider_subscription_id: event.original_transaction_id,
                has_reached_limit: hasReachedLimit,
            };



            await subscriptionsDB.updateSubscriptionByUserId(userId, updates);
        } else {
            // Create new record
            await subscriptionsDB.createSubscription({
                userId,
                tier: targetTier,
                provider: 'revenuecat',
                status: status,
                currentPeriodEnd: currentPeriodEnd,
                providerCustomerId: event.original_app_user_id,
                providerSubscriptionId: event.original_transaction_id,
            });
        }

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
        });
    } catch (err) {
        console.error('RevenueCat Webhook Error:', err);
        if (err instanceof Error) {
            return error(400, err.message);
        }
        return error(500, 'Internal Server Error');
    }
};

export default revenueCatWebhookHandler;
