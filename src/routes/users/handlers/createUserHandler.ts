import { env } from 'cloudflare:workers';
import { createInviteCodesDB, createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { createAuthService } from 'services/auth.svc';
import { AppRoles, AuthRequest, Gender } from 'types';

type CreateUserBody = {
	name: string;
	email?: string;
	gender?: Gender;
	inviteCode?: string;
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

		const usersDB = createUsersDB(env.GOSTYLENS_DB);

		const existingUser = await usersDB.getUserByAuthId(authId);
		if (existingUser) {
			return error(409, 'User already exists');
		}

		let inviteLimits: Parameters<typeof usersDB.createUser>[0]['inviteLimits'];
		let inviteRedemption: Parameters<typeof usersDB.createUser>[0]['inviteRedemption'];

		if (body.inviteCode) {
			const inviteCodesDB = createInviteCodesDB(env.GOSTYLENS_DB);
			try {
				const invite = await inviteCodesDB.getRedeemableCode(body.inviteCode);
				inviteLimits = {
					trial_days: invite.trial_days,
					trial_session_limit: invite.trial_session_limit,
					monthly_session_limit: invite.monthly_session_limit,
					message_per_session_limit: invite.message_per_session_limit,
					image_per_session_limit: invite.image_per_session_limit,
				};
				inviteRedemption = { inviteId: invite.id };
			} catch (inviteErr) {
				const message = inviteErr instanceof Error ? inviteErr.message : 'Invalid invite code';
				return error(400, message);
			}
		}

		const newUser = await usersDB.createUser({
			authId: authId,
			name: body.name,
			email: body.email,
			gender: body.gender,
			inviteLimits,
			inviteRedemption,
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
