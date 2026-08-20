import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { verifyTimingSafe } from 'utils/crypto';
import { ApiRequest } from 'types';

export const adminApiKeyMiddleware: RequestHandler<ApiRequest> = async (request) => {
    const apiKey = request.headers.get('x-admin-api-key');

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
