import { env } from 'cloudflare:workers';
import { createPushTokensDB, createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { ProvisionedAuthRequest } from 'types';
import { parseOptionalTimeZone } from '../../../utils/timezone.utils';

type UpsertPushTokenBody = {
	token?: string;
	platform?: 'ios' | 'android';
	/** Optional IANA time zone (e.g. Europe/Amsterdam). Omitted → leave users.timezone unchanged. */
	timezone?: string | null;
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

		let timezone: string | null | undefined;
		if (Object.prototype.hasOwnProperty.call(body, 'timezone')) {
			try {
				timezone = parseOptionalTimeZone(body.timezone);
			} catch (err) {
				return error(400, err instanceof Error ? err.message : 'Invalid timezone');
			}
		}

		const pushTokensDB = createPushTokensDB(env.GOSTYLENS_DB);
		await pushTokensDB.upsertToken({
			userId,
			token: body.token,
			platform: body.platform,
		});

		if (timezone !== undefined) {
			const usersDB = createUsersDB(env.GOSTYLENS_DB);
			await usersDB.updateUser(userId, { timezone });
		}

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
