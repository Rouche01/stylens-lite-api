import { env } from 'cloudflare:workers';
import { createPushTokensDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { ProvisionedAuthRequest } from 'types';

type UpsertPushTokenBody = {
	token?: string;
	platform?: 'ios' | 'android';
};

const upsertPushTokenHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const userId = request.user.dbId;
		const body = (await request.json()) as UpsertPushTokenBody;

		if (!body.token || !body.platform) {
			return error(400, 'Both "token" and "platform" are required.');
		}

		if (body.platform !== 'ios' && body.platform !== 'android') {
			return error(400, 'Platform must be either "ios" or "android".');
		}

		const pushTokensDB = createPushTokensDB(env.GOSTYLENS_DB);
		await pushTokensDB.upsertToken({
			userId,
			token: body.token,
			platform: body.platform,
		});

		return new Response(JSON.stringify({ success: true }), {
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

export default upsertPushTokenHandler;
