import { env } from 'cloudflare:workers';
import { createUserEmailPrefsDB, createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { createEmailProvider } from 'services/email/providers';
import { verifyUnsubscribeToken } from 'utils/email_unsubscribe.utils';
import { ApiRequest } from 'types';

async function unsubscribeUser(userId: string, log: ApiRequest['log']): Promise<void> {
	const prefsDB = createUserEmailPrefsDB(env.GOSTYLENS_DB);
	await prefsDB.updateMarketingOptIn(userId, false);

	const usersDB = createUsersDB(env.GOSTYLENS_DB);
	const user = await usersDB.getUserById(userId);
	if (user?.email) {
		const provider = createEmailProvider(env);
		await provider.suppress?.(user.email);
	}

	log.info('email_unsubscribed', { user_id: userId });
}

function successHtml(): Response {
	return new Response(
		`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem;">
  <h1>You're unsubscribed</h1>
  <p>You won't receive marketing emails from GoStylens. You can turn tips back on anytime in the app Profile menu.</p>
</body>
</html>`,
		{
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}
	);
}

const unsubscribeEmailHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const url = new URL(request.url);
		const token = url.searchParams.get('token');
		if (!token) {
			return error(400, 'token query parameter is required');
		}

		const { userId } = await verifyUnsubscribeToken(token, env.EMAIL_UNSUBSCRIBE_SECRET);
		await unsubscribeUser(userId, request.log);

		// One-click List-Unsubscribe-Post expects 200/202 with empty body
		if (request.method === 'POST') {
			return new Response(null, { status: 202 });
		}

		return successHtml();
	} catch (err) {
		request.log.warn('email_unsubscribe_failed', {}, err);
		if (request.method === 'POST') {
			return error(400, 'Invalid or expired unsubscribe token');
		}
		return new Response(
			`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribe failed</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem;">
  <h1>Link expired or invalid</h1>
  <p>Open the GoStylens app → Profile to manage email preferences.</p>
</body>
</html>`,
			{
				status: 400,
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			}
		);
	}
};

export default unsubscribeEmailHandler;
