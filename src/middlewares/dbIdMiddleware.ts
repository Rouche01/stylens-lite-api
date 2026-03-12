import { error, RequestHandler } from 'itty-router';
import { AuthRequest } from 'types';

export const dbIdMiddleware: RequestHandler<AuthRequest> = (request) => {
    if (!request.user.dbId) {
        return error(401, 'Unauthorized: User profile not found in database. Please complete onboarding.');
    }
};
