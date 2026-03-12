import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { createAuthService } from 'services/auth.svc';
import { ProvisionedAuthRequest } from 'types';

const deleteUserHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { userId } = request.params;

		if (!userId) {
			return error(400, 'userId query parameter is required');
		}

		if (userId !== request.user.dbId) {
			return error(403, 'Forbidden: You can only perform this action on your own user data');
		}

		const usersDB = createUsersDB(env.gostylens_db);
		const user = await usersDB.getUserById(userId);

		if (!user) {
			return error(404, 'User not found');
		}

		// Delete from Supabase first
		const authService = createAuthService();
		try {
			await authService.deleteUser(user.auth_id);
		} catch (supabaseErr) {
			console.error('Failed to delete user from Supabase:', supabaseErr);
			return error(500, 'Failed to delete authentication account. Please try again.');
		}

		// Then delete from our DB
		await usersDB.deleteUser(userId);

		return new Response(
			JSON.stringify({
				message: 'User deleted successfully',
				userId,
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default deleteUserHandler;
