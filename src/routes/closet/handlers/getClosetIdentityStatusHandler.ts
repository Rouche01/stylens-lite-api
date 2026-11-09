import { error, RequestHandler } from 'itty-router';
import { closetIdentityStatusPayload, createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { logRouteError } from 'utils/error';

const getClosetIdentityStatusHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const counts = await closetDB.countIdentityJobsByStatus(request.user.dbId);
		return new Response(JSON.stringify(closetIdentityStatusPayload(counts)), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		logRouteError(request.log, 'get_closet_identity_status_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default getClosetIdentityStatusHandler;
