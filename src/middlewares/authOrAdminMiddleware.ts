import { RequestHandler } from 'itty-router';
import { ApiRequest, AuthRequest } from 'types';
import { adminApiKeyMiddleware } from './adminApiKeyMiddleware';
import { authMiddleware } from './authMiddleware';
import { dbIdMiddleware } from './dbIdMiddleware';

/**
 * JWT user (must have dbId) or x-admin-api-key.
 * Admin callers must pass userId in the handler body.
 */
export const authOrAdminMiddleware: RequestHandler<ApiRequest> = async (request) => {
	if (request.headers.get('x-admin-api-key')) {
		return adminApiKeyMiddleware(request);
	}

	const authError = await authMiddleware(request as AuthRequest);
	if (authError) return authError;

	return dbIdMiddleware(request as AuthRequest);
};
