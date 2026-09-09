import { error, json, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { ApiRequest } from 'types';
import { createEmailProvider } from 'services/email/providers';
import { renderEmailTemplate } from 'services/email/templates';
import { buildUnsubscribeUrl } from 'utils/email_unsubscribe.utils';

type Body = {
	to?: string;
	name?: string;
};

/**
 * Dev-only smoke test: send activation_d0 via the ESP without D1 segment/opt-in.
 * Requires x-admin-api-key. Blocked outside ENV_NAME=dev.
 */
const testSendEmailHandler: RequestHandler<ApiRequest> = async (request) => {
	if (env.ENV_NAME !== 'dev') {
		return error(404, 'Not Found');
	}

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return error(400, 'Invalid JSON body');
	}

	const to = body.to?.trim();
	if (!to || !to.includes('@')) {
		return error(400, 'Body must include a valid "to" email');
	}

	const apiBase = env.EMAIL_API_BASE_URL?.trim() || 'http://127.0.0.1:8787';
	const deepLinkUrl = env.EMAIL_APP_DEEP_LINK?.trim() || 'https://gostylens.app';

	let unsubscribeUrl: string | undefined;
	try {
		unsubscribeUrl = await buildUnsubscribeUrl({
			baseUrl: apiBase,
			userId: 'test-send',
			secret: env.EMAIL_UNSUBSCRIBE_SECRET,
		});
	} catch (err) {
		request.log.warn('test_send_unsub_url_skipped', {}, err);
	}

	const rendered = renderEmailTemplate('activation_d0', {
		userName: body.name?.trim() || 'there',
		unsubscribeUrl,
		deepLinkUrl,
	});

	const provider = createEmailProvider(env);
	const result = await provider.send({
		to,
		subject: `[test] ${rendered.subject}`,
		html: rendered.html,
		text: rendered.text,
		headers: unsubscribeUrl
			? {
					'List-Unsubscribe': `<${unsubscribeUrl}>`,
					'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
				}
			: undefined,
		tags: [
			{ name: 'template_key', value: 'activation_d0' },
			{ name: 'test_send', value: 'true' },
		],
	});

	request.log.info('email_test_sent', {
		to,
		provider: provider.name,
		provider_message_id: result.providerMessageId,
	});

	return json({
		ok: true,
		provider: provider.name,
		providerMessageId: result.providerMessageId,
		to,
	});
};

export default testSendEmailHandler;
