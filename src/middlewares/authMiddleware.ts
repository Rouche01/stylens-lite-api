import { error, RequestHandler } from 'itty-router';
import { createAuthService } from '../services/auth.svc';
import { AuthRequest, AuthUser } from 'types';

export const authMiddleware: RequestHandler<AuthRequest> = async (request) => {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return error(401, 'Unauthorized: Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];
    // console.log("token: ", token);

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
        request.log = request.log.child({
            user_id: authUser.dbId ?? authUser.authId,
        });
    } catch (err) {
        request.log.error('jwt_verification_failed', {}, err);
        return error(401, 'Unauthorized: Invalid or expired token');
    }
};
