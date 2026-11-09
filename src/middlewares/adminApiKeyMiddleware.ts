import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { verifyTimingSafe } from 'utils/crypto';
import { ApiRequest } from 'types';

function readAdminApiKey(request: ApiRequest, allowQueryParam: boolean): string | null {
	const header = request.headers.get('x-admin-api-key');
	if (header) return header;
	if (!allowQueryParam) return null;
	try {
		return new URL(request.url).searchParams.get('admin_key');
	} catch {
		return null;
	}
}

function createAdminApiKeyMiddleware(allowQueryParam: boolean): RequestHandler<ApiRequest> {
	return async (request) => {
		const apiKey = readAdminApiKey(request, allowQueryParam);

		if (!apiKey) {
			return error(401, 'Unauthorized: Missing admin API key');
		}

		const expectedKey = env.ADMIN_API_KEY;

		if (!expectedKey) {
			request.log.error('admin_api_key_missing');
			return error(500, 'Internal server error');
		}

		if (!verifyTimingSafe(apiKey, expectedKey)) {
			return error(403, 'Forbidden: Invalid API key');
		}

		request.isAdmin = true;
	};
}

export const adminApiKeyMiddleware = createAdminApiKeyMiddleware(false);

/** Same as adminApiKeyMiddleware, plus `?admin_key=` for browser GET previews. */
export const adminApiKeyQueryMiddleware = createAdminApiKeyMiddleware(true);
