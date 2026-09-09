import { env } from 'cloudflare:workers';
import { createUserEmailPrefsDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { ProvisionedAuthRequest } from 'types';
import { UserEmailPrefs } from 'db/types';

type UpdateEmailPrefsBody = {
	marketingOptIn?: boolean;
};

function prefsResponse(prefs: UserEmailPrefs | null) {
	return {
		marketingOptIn: prefs?.marketing_opt_in === 1,
		marketingOptInAt: prefs?.marketing_opt_in_at ?? null,
		marketingUnsubscribedAt: prefs?.marketing_unsubscribed_at ?? null,
	};
}

const updateEmailPrefsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const userId = request.user.dbId;
		const body = (await request.json()) as UpdateEmailPrefsBody;

		if (typeof body.marketingOptIn !== 'boolean') {
			return error(400, 'marketingOptIn (boolean) is required');
		}

		const prefsDB = createUserEmailPrefsDB(env.GOSTYLENS_DB);
		const prefs = await prefsDB.updateMarketingOptIn(userId, body.marketingOptIn);

		request.log.info('email_prefs_updated', {
			user_id: userId,
			marketing_opt_in: body.marketingOptIn,
		});

		return new Response(JSON.stringify(prefsResponse(prefs)), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		request.log.error('email_prefs_update_failed', {}, err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default updateEmailPrefsHandler;
