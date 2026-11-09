import { env } from 'cloudflare:workers';
import { createUserEmailPrefsDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { ProvisionedAuthRequest } from 'types';

const getEmailPrefsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const userId = request.user.dbId;
		const prefsDB = createUserEmailPrefsDB(env.GOSTYLENS_DB);
		const prefs = await prefsDB.getByUserId(userId);

		return new Response(
			JSON.stringify({
				marketingOptIn: prefs?.marketing_opt_in === 1,
				marketingOptInAt: prefs?.marketing_opt_in_at ?? null,
				marketingUnsubscribedAt: prefs?.marketing_unsubscribed_at ?? null,
			}),
			{ headers: { 'Content-Type': 'application/json' } }
		);
	} catch (err) {
		request.log.error('email_prefs_get_failed', {}, err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default getEmailPrefsHandler;
