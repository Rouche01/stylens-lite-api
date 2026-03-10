import { error, RequestHandler } from 'itty-router';
import { createSubscriptionsDB } from 'db';
import { env } from 'cloudflare:workers';
import { AuthRequest } from 'types';

const getSubscriptionByUserIdHandler: RequestHandler<AuthRequest> = async (request) => {
    try {
        const { userId } = request.params;

        if (!userId) {
            return error(400, 'userId parameter is required');
        }

        // Optional: Ensure the authenticated user can only fetch their own subscription
        // If an admin role exists, you might allow them to fetch others
        if (request.user.dbId !== userId && request.user.role !== 'root-admin') {
            return error(403, 'Forbidden: You can only access your own subscription data');
        }

        const subscriptionDB = createSubscriptionsDB(env.gostylens_db);
        const subscription = await subscriptionDB.getSubscriptionByUserId(userId);

        if (!subscription) {
            return error(404, 'Subscription not found for the given user');
        }

        return new Response(JSON.stringify(subscription), {
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

export default getSubscriptionByUserIdHandler;
