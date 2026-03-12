import { error, RequestHandler } from 'itty-router';
import { createAuthService } from '../services/auth.svc';
import { AuthUser } from 'types';

export const authMiddleware: RequestHandler = async (request) => {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return error(401, 'Unauthorized: Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];

    try {
        const authService = createAuthService();
        const payload = await authService.verifyJWT(token);

        const authUser: AuthUser = {
            authId: payload.sub,
            email: payload.email,
            role: payload.app_metadata?.role,
            dbId: payload.app_metadata?.dbId,
        }

        // Attach user info to request
        request.user = authUser;
    } catch (err) {
        console.error('JWT verification failed:', err);
        return error(401, 'Unauthorized: Invalid or expired token');
    }
};
