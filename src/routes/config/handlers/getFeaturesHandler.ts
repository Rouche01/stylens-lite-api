import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { AuthRequest } from 'types';
import { evaluatePostHogFlags, flagsForClient } from 'services/featureFlags.svc';
import { createPostHogFlagClient } from 'services/posthog.svc';

const getFeaturesHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		const authId = request.user.authId?.trim();
		if (!authId) {
			return new Response(JSON.stringify({ flags: {} }), {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				},
			});
		}

		const client = createPostHogFlagClient(env);
		try {
			const snapshot = await evaluatePostHogFlags({ client, distinctId: authId });
			return new Response(JSON.stringify({ flags: flagsForClient(snapshot) }), {
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				},
			});
		} finally {
			await client?.shutdown();
		}
	} catch (err) {
		request.log?.error('get_features_failed', {}, err);
		return error(500, 'Internal Server Error');
	}
};

export default getFeaturesHandler;
