import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { createAuthService } from 'services/auth.svc';
import { AppRoles, AuthRequest, Gender } from 'types';

type CreateUserBody = {
	name: string;
	email?: string;
	gender?: Gender;
};

const createUserHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		const body = (await request.json()) as CreateUserBody;
		const { authId } = request.user;

		if (!authId || !body.name) {
			return error(400, 'authId (from token) and name are required to create a user');
		}

		if (body.gender !== undefined && body.gender !== null && !Object.values(Gender).includes(body.gender)) {
			return error(400, `gender must be one of: ${Object.values(Gender).join(', ')}`);
		}

		const usersDB = createUsersDB(env.gostylens_db);

		const existingUser = await usersDB.getUserByAuthId(authId);
		if (existingUser) {
			return error(409, 'User already exists');
		}

		const newUser = await usersDB.createUser({
			authId: authId,
			name: body.name,
			email: body.email,
			gender: body.gender,
		});

		const authService = createAuthService();

		try {
			// Update the user's app_metadata in Supabase
			await authService.updateUserAuthMetadata(authId, {
				role: AppRoles.DefaultUser,
				dbId: newUser.id,
			});
		} catch (supabaseErr) {
			console.error('Failed to update Supabase app_metadata, rolling back user creation.', supabaseErr);
			// Rollback the DB creation
			await usersDB.deleteUser(newUser.id);

			return error(500, 'Failed to fully register user. Please try again.');
		}


		return new Response(JSON.stringify(newUser), {
			headers: { 'Content-Type': 'application/json' },
			status: 201,
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default createUserHandler;
