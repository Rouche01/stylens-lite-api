import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { AuthRequest, Gender } from 'types';

type UpdateUserBody = {
	name?: string;
	email?: string;
	gender?: Gender;
};

const updateUserHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		const { userId } = request.params;
		if (!userId) {
			return error(400, 'userId query parameter is required');
		}

		if (request.user.dbId !== userId && request.user.role !== 'root-admin') {
			return error(403, 'Forbidden: You can only access your own user data');
		}

		const body = (await request.json()) as UpdateUserBody;

		if (!body.name && !body.email && !body.gender) {
			return error(400, 'At least one field (name, email, gender) must be provided to update');
		}

		if (body.gender !== undefined && body.gender !== null && !Object.values(Gender).includes(body.gender)) {
			return error(400, `gender must be one of: ${Object.values(Gender).join(', ')}`);
		}

		const usersDB = createUsersDB(env.gostylens_db);

		const user = await usersDB.getUserById(userId);
		if (!user) {
			return error(404, 'User not found');
		}

		const updatedUser = await usersDB.updateUser(userId, {
			name: body.name,
			email: body.email,
			gender: body.gender,
		});

		if (!updatedUser) {
			return error(500, 'Failed to update user');
		}

		return new Response(JSON.stringify(updatedUser), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};
export default updateUserHandler;
