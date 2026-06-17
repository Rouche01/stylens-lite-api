import { RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createLogger } from 'utils/logger.utils';
import { ApiRequest } from 'types';

export const loggingMiddleware: RequestHandler<ApiRequest> = async (request) => {
	const url = new URL(request.url);
	const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();

	request.log = createLogger({
		env: env.ENV_NAME,
		context: {
			request_id: requestId,
			method: request.method,
			path: url.pathname,
		},
	});
};
