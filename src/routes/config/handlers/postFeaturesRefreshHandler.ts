import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { ApiRequest } from 'types';
import { refreshPostHogFlagDefinitions } from 'services/posthog.svc';

const postFeaturesRefreshHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const result = await refreshPostHogFlagDefinitions(env);
		if (!result.refreshed) {
			return new Response(JSON.stringify(result), {
				status: 503,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		request.log?.info('posthog_flag_definitions_refreshed', { source: 'admin' });
		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		request.log?.error('posthog_flag_definitions_refresh_failed', { source: 'admin' }, err);
		return error(500, 'Internal Server Error');
	}
};

export default postFeaturesRefreshHandler;
