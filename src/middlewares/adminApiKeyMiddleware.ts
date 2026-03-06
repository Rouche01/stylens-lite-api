import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';

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

    // Use timing-safe comparison to prevent timing attacks
    const encoder = new TextEncoder();
    const a = encoder.encode(apiKey);
    const b = encoder.encode(expectedKey);

    if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
        return error(403, 'Forbidden: Invalid API key');
    }

    // Tag the request as admin-authenticated
    request.isAdmin = true;
};
