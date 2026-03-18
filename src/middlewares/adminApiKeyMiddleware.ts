import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { verifyTimingSafe } from 'utils/crypto';

export const adminApiKeyMiddleware: RequestHandler = async (request) => {
    const apiKey = request.headers.get('x-api-key');

    if (!apiKey) {
        return error(401, 'Unauthorized: Missing API key');
    }

    const expectedKey = env.ADMIN_API_KEY;

    if (!expectedKey) {
        console.error('ADMIN_API_KEY environment variable is not configured');
        return error(500, 'Internal server error');
    }

    if (!verifyTimingSafe(apiKey, expectedKey)) {
        return error(403, 'Forbidden: Invalid API key');
    }

    request.isAdmin = true;
};
