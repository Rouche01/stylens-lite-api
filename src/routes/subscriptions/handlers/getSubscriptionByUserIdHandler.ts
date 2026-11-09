import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB, createSubscriptionsDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { createStyleAnalysisService } from 'services/style_analysis.svc';

const getSubscriptionByUserIdHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
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

        const subscriptionDB = createSubscriptionsDB(env.GOSTYLENS_DB);
        const subscription = await subscriptionDB.getSubscriptionByUserId(userId);

        if (!subscription) {
            return error(404, 'Subscription not found for the given user');
        }

        // Fetch effective limits to return with the subscription data
        const styleAnalysisService = createStyleAnalysisService(env);
        const limits = await styleAnalysisService.getEffectiveLimits(userId);
        const styleAnalysisDB = createStyleAnalysisDB(env.GOSTYLENS_DB);
        const sessionUsage = await styleAnalysisDB.countSessionsSince(userId, limits.periodStart);

        return new Response(JSON.stringify({
            ...subscription,
            limits: {
                'session_count_limit': limits.sessionCountLimit,
                'message_per_session_limit': limits.messagePerSessionLimit,
                'image_per_session_limit': limits.imagePerSessionLimit,
            },
            in_trial: limits.inTrial,
            trial_ends_at: limits.trialEndsAt,
            period_start: limits.periodStart,
            session_usage: sessionUsage,
        }), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' },
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
