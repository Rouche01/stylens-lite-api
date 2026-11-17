import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createClosetDB, createUsersDB } from 'db';
import {
	EvalUserResetError,
	resetEvalUserCloset,
} from 'services/identity/eval/resetEvalUser';
import { ApiRequest } from 'types';
import { logRouteError } from 'utils/error';

type ResetEvalUserBody = {
	userId?: string;
};

/**
 * Wipe closet / identity state for the dedicated EVAL_USER_ID only.
 * POST /closet/eval/reset
 * Header: x-admin-api-key
 * Body: { userId } — must equal EVAL_USER_ID
 */
const resetEvalUserHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as ResetEvalUserBody;
		const userId = body.userId?.trim();
		if (!userId) {
			return error(400, 'userId is required');
		}

		const user = await createUsersDB(env.GOSTYLENS_DB).getUserById(userId);
		if (!user) {
			return error(404, 'User not found');
		}

		const result = await resetEvalUserCloset({
			env,
			closet: createClosetDB(env.GOSTYLENS_DB),
			userId,
			log: request.log,
		});

		return new Response(JSON.stringify({ ok: true, ...result }), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		if (err instanceof EvalUserResetError) {
			request.log.warn('eval_user_reset_rejected', { status: err.status, message: err.message });
			return error(err.status, err.message);
		}
		logRouteError(request.log, 'eval_user_reset_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default resetEvalUserHandler;
