import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { SubscriptionTier } from 'types';
import type { Subscription } from 'db/types';

const getUserByAuthIdHandler: RequestHandler = async (request) => {
    try {
        const { authId } = request.params;
        if (!authId) {
            return error(400, 'authId query parameter is required');
        }

        const usersDB = createUsersDB(env.gostylens_db);

        const user = await usersDB.getUserByAuthId(authId);
        if (!user) {
            return error(404, 'User not found');
        }

        if (!user.subscription) {
            // if it doesn't exist for some rare reason, we can still polyfill
            // or we could assume the DB has it. Let's polyfill for the response just in case.
            const defaultSubscription: Subscription = {
                id: 'default',
                user_id: user.id,
                tier: SubscriptionTier.Free,
                provider: null,
                provider_customer_id: null,
                provider_subscription_id: null,
                status: 'active',
                current_period_end: null,
                created_at: Date.now(),
                updated_at: Date.now(),
            };
            user.subscription = defaultSubscription;
        }

        return new Response(JSON.stringify(user), {
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

export default getUserByAuthIdHandler;
