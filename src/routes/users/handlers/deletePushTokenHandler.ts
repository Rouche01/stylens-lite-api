import { env } from 'cloudflare:workers';
import { createPushTokensDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { ProvisionedAuthRequest } from 'types';

const deletePushTokenHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const userId = request.user.dbId;
		const { token } = request.params;

		if (!token) {
			return error(400, 'Token parameter is required.');
		}

		const pushTokensDB = createPushTokensDB(env.GOSTYLENS_DB);
		await pushTokensDB.deleteToken(decodeURIComponent(token), userId);

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

export default deletePushTokenHandler;
