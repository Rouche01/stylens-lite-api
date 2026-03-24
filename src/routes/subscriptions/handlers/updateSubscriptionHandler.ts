import { error, RequestHandler } from 'itty-router';
import { createSubscriptionsDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest, SubscriptionTier } from 'types';

type UpdateSubscriptionBody = {
    tier?: SubscriptionTier;
    provider?: string;
    providerCustomerId?: string;
    providerSubscriptionId?: string;
    status?: string;
    currentPeriodEnd?: number;
    hasReachedLimit?: 0 | 1;
};

const updateSubscriptionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
    try {
        const { userId } = request.params;

        if (!userId) {
            return error(400, 'userId parameter is required');
        }

        if (request.user.dbId !== userId && request.user.role !== 'root-admin') {
            return error(403, 'Forbidden: You can only update your own subscription');
        }

        const subscriptionsDB = createSubscriptionsDB(env.gostylens_db);
        const subscription = await subscriptionsDB.getSubscriptionByUserId(userId);

        if (!subscription) {
            return error(404, 'Subscription not found for the given user');
        }

        const body = (await request.json()) as UpdateSubscriptionBody;

        // Map camelCase body fields to snake_case DB columns
        const updates: Record<string, unknown> = {};

        if (body.tier !== undefined) updates.tier = body.tier;
        if (body.provider !== undefined) updates.provider = body.provider;
        if (body.providerCustomerId !== undefined) updates.provider_customer_id = body.providerCustomerId;
        if (body.providerSubscriptionId !== undefined) updates.provider_subscription_id = body.providerSubscriptionId;
        if (body.status !== undefined) updates.status = body.status;
        if (body.currentPeriodEnd !== undefined) updates.current_period_end = body.currentPeriodEnd;
        if (body.hasReachedLimit !== undefined) updates.has_reached_limit = body.hasReachedLimit;

        const updatedSubscription = await subscriptionsDB.updateSubscriptionByUserId(userId, updates);

        return new Response(JSON.stringify(updatedSubscription), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
        });
    } catch (err) {
        if (err instanceof Error) {
            return error(400, err.message);
        }
        return error(500, 'Internal Server Error');
    }
};

export default updateSubscriptionHandler;
