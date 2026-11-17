import { error, json, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createEmailSendsDB, createUserEmailPrefsDB } from 'db';
import { createEmailProvider } from 'services/email/providers';
import { ApiRequest } from 'types';
import { logRouteError } from 'utils/error';

/**
 * ESP webhook ingress. Provider verifies signature + normalizes; D1 is updated here.
 * Configure Resend → POST {EMAIL_API_BASE_URL}/webhooks/email
 */
const emailWebhookHandler: RequestHandler<ApiRequest> = async (request) => {
	const log = request.log.child({ service: 'email_webhook' });

	try {
		const provider = createEmailProvider(env);
		if (!provider.parseWebhook) {
			return error(501, 'Email provider does not support webhooks');
		}

		let event;
		try {
			event = await provider.parseWebhook(request);
		} catch (err) {
			log.warn('email_webhook_invalid', {}, err);
			return error(400, 'Invalid webhook signature or payload');
		}

		if (!event) {
			return json({ ok: true, ignored: true });
		}

		const sendsDB = createEmailSendsDB(env.GOSTYLENS_DB);
		const updated = await sendsDB.applyWebhookEvent({
			providerMessageId: event.providerMessageId,
			status: event.status,
			openedAt: event.openedAt,
			clickedAt: event.clickedAt,
		});

		if (!updated) {
			log.info('email_webhook_unknown_message', {
				provider_message_id: event.providerMessageId,
				status: event.status,
			});
			return json({ ok: true, matched: false });
		}

		log.info('email_webhook_applied', {
			send_id: updated.id,
			user_id: updated.user_id,
			provider_message_id: event.providerMessageId,
			status: updated.status,
		});

		if (event.status === 'bounced' || event.status === 'complained') {
			const prefsDB = createUserEmailPrefsDB(env.GOSTYLENS_DB);
			await prefsDB.updateMarketingOptIn(updated.user_id, false);

			const email =
				event.recipientEmails?.[0] ??
				undefined;
			if (email && provider.suppress) {
				await provider.suppress(email);
			}

			log.info('email_webhook_suppressed', {
				user_id: updated.user_id,
				reason: event.status,
			});
		}

		return json({ ok: true, matched: true, status: updated.status });
	} catch (err) {
		logRouteError(log, 'email_webhook_failed', err);
		return error(500, 'Internal Server Error');
	}
};

export default emailWebhookHandler;
