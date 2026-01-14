import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';

const deleteUserHandler: RequestHandler = async (request) => {
	try {
		const { userId } = request.params;

		if (!userId) {
			return error(400, 'userId query parameter is required');
		}

		const usersDB = createUsersDB(env.gostylens_db);

		const user = await usersDB.getUserById(userId);

		if (!user) {
			return error(404, 'User not found');
		}

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
