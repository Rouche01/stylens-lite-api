import { error } from 'itty-router';
import { createUsersDB } from 'db';
import { env } from 'cloudflare:workers';
import { ApiRequest, AuthRequest } from 'types';

export async function requireClosetUserId(
	request: ApiRequest,
	adminUserId?: string
): Promise<string | Response> {
	if (request.isAdmin) {
		const userId = adminUserId?.trim();
		if (!userId) {
			return error(400, 'userId is required when using an admin API key');
		}
		const user = await createUsersDB(env.GOSTYLENS_DB).getUserById(userId);
		if (!user) {
			return error(404, 'User not found');
		}
		return userId;
	}

	const userId = (request as AuthRequest).user?.dbId;
	if (!userId) {
		return error(401, 'Unauthorized: User profile not found in database. Please complete onboarding.');
	}
	return userId;
}

export function isErrorResponse(value: string | Response): value is Response {
	return typeof value !== 'string';
}
