import { error, RequestHandler } from 'itty-router';
import { createUserLimitsDB } from 'db';
import { AuthRequest } from 'types';
import { createStyleAnalysisService } from 'services/style_analysis.svc';
import { env } from 'cloudflare:workers';

type UpdateUserLimitBody = {
	userId: string;
	sessionCountLimit?: number | null;
	messagePerSessionLimit?: number | null;
	imagePerSessionLimit?: number | null;
};

const updateUserLimitHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
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

		// Sync the has_reached_limit flag in the background so the mobile app UI reflects the change
		const ctx = (request as any).ctx;
		const styleAnalysisService = createStyleAnalysisService(env);
		styleAnalysisService.syncSessionLimitFlagInBackground({ userId: body.userId, ctx });

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
