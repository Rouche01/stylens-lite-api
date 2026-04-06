import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { RequestHandler } from 'itty-router';
import { AuthRequest, SubscriptionTier } from 'types';
import type { Subscription } from 'db/types';
import { apiError } from 'utils/error';

const getUserByAuthIdHandler: RequestHandler<AuthRequest> = async (request) => {
    try {
        const { authId } = request.params;
        if (!authId) {
            return apiError(400, 'authId query parameter is required');
        }

        if (authId !== request.user.authId) {
            return apiError(403, 'Forbidden: You can only access your own user data');
        }

        const usersDB = createUsersDB(env.gostylens_db);

        const user = await usersDB.getUserByAuthId(authId);
        if (!user) {
            return apiError(404, 'User not found', 'USER_NOT_FOUND');
        }

        if (!user.subscription) {
            // if it doesn't exist for some rare reason, we can still polyfill
            // or we could assume the DB has it. Let's polyfill for the response just in case.
            const defaultSubscription: Subscription = {
                id: 'default',
                user_id: user.id,
                has_reached_limit: 0,
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
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' },
            status: 200,
        });
    } catch (err) {
        if (err instanceof Error) {
            return apiError(400, err.message);
        }
        return apiError(500, 'Internal Server Error');
    }
};

export default getUserByAuthIdHandler;
