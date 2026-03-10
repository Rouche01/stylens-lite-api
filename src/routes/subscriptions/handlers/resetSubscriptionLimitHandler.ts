import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createSubscriptionsDB } from 'db';
import { AuthRequest } from 'types';

type ResetSubscriptionBody = {
    userId: string;
}

const resetSubscriptionLimitHandler: RequestHandler<AuthRequest> = async (request) => {
    try {
        const { userId } = (await request.json()) as ResetSubscriptionBody;

        if (!userId) {
            return error(400, 'userId is required');
        }

        const subscriptionsDB = createSubscriptionsDB(env.gostylens_db);

        // First, check if the subscription even exists
        const subscription = await subscriptionsDB.getSubscriptionByUserId(userId);
        if (!subscription) {
            return error(404, 'Subscription not found for this user');
        }

        // Hard delete only the most recent session for this user
        await env.gostylens_db.prepare(
            `DELETE FROM style_analysis_histories WHERE id = (
                SELECT id FROM style_analysis_histories WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
            )`
        ).bind(userId).run();

        // Reset the limit cached flag
        const updatedSubscription = await subscriptionsDB.updateSubscriptionByUserId(userId, { has_reached_limit: 0 });

        return new Response(JSON.stringify({
            message: 'User free limit successfully reset',
            subscription: updatedSubscription
        }), {
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

export default resetSubscriptionLimitHandler;
