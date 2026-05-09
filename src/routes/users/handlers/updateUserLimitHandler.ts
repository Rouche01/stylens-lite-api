import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createUserLimitsDB } from 'db';
import { AuthRequest } from 'types';

type UpdateUserLimitBody = {
	userId: string;
	sessionCountLimit?: number | null;
	messagePerSessionLimit?: number | null;
	imagePerSessionLimit?: number | null;
};

const updateUserLimitHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		// Ideally, this should be restricted to admins
		// For now, we'll implement the logic as requested
		const body = (await request.json()) as UpdateUserLimitBody;

		if (!body.userId) {
			return error(400, 'userId is required');
		}

		const userLimitsDB = createUserLimitsDB(env.GOSTYLENS_DB);

		const updatedLimit = await userLimitsDB.updateUserLimit(body.userId, {
			session_count_limit: body.sessionCountLimit,
			message_per_session_limit: body.messagePerSessionLimit,
			image_per_session_limit: body.imagePerSessionLimit,
		});

		return new Response(JSON.stringify(updatedLimit), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default updateUserLimitHandler;
