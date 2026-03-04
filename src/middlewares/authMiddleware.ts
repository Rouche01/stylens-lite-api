import { error, RequestHandler } from 'itty-router';
import { createAuthService } from '../services/auth.svc';
import { type AppRole } from 'types';

export const authMiddleware: RequestHandler = async (request) => {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return error(401, 'Unauthorized: Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];

    try {
        const authService = createAuthService();
        const payload = await authService.verifyJWT(token);

        // Attach user info to request
        request.user = {
            authId: payload.sub,
            email: payload.email as string,
            role: payload.role as AppRole,
            ...payload
        }
    } catch (err) {
        console.error('JWT verification failed:', err);
        return error(401, 'Unauthorized: Invalid or expired token');
    }
};
