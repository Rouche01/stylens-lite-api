import { env } from 'cloudflare:workers';
import {
	createUsersDB,
	createUserEmailPrefsDB,
	UsersDB,
	UserEmailPrefsDB,
} from '../db';
import { EmailSendsDB } from '../db/email_sends';
import { createLogger, Logger } from '../utils/logger.utils';
import { EmailProvider } from './email/providers/base.provider';
import { createEmailProvider } from './email/providers';
import { renderEmailTemplate } from './email/templates';
import { EmailTemplateKey } from './email/types';

export type SendLifecycleEmailParams = {
	userId: string;
	templateKey: EmailTemplateKey;
	campaignKey?: string;
	/** Absolute unsubscribe URL for List-Unsubscribe + footer */
	unsubscribeUrl?: string;
	/** Deep link CTA (Capture, etc.) */
	deepLinkUrl?: string;
};

export type SendLifecycleEmailResult =
	| { status: 'sent'; sendId: string; providerMessageId: string }
	| { status: 'skipped'; reason: 'no_email' | 'not_opted_in' | 'already_sent' };

export class EmailService {
	constructor(
		private usersDB: UsersDB,
		private prefsDB: UserEmailPrefsDB,
		private sendsDB: EmailSendsDB,
		private provider: EmailProvider,
		private log: Logger
	) {}

	/**
	 * Sends a consented lifecycle email. Idempotent per (user, template, campaign).
	 * No public HTTP route should call this — cron / internal jobs only.
	 */
	async sendLifecycleEmail(
		params: SendLifecycleEmailParams
	): Promise<SendLifecycleEmailResult> {
		const { userId, templateKey, campaignKey = null, unsubscribeUrl, deepLinkUrl } =
			params;
		const log = this.log.child({
			user_id: userId,
			template_key: templateKey,
			campaign_key: campaignKey,
			provider: this.provider.name,
		});

		const user = await this.usersDB.getUserById(userId);
		if (!user?.email?.trim()) {
			log.info('email_send_skipped', { reason: 'no_email' });
			return { status: 'skipped', reason: 'no_email' };
		}

		const eligible = await this.prefsDB.isMarketingEligible(userId);
		if (!eligible) {
			log.info('email_send_skipped', { reason: 'not_opted_in' });
			return { status: 'skipped', reason: 'not_opted_in' };
		}

		if (await this.sendsDB.hasSent(userId, templateKey, campaignKey)) {
			log.info('email_send_skipped', { reason: 'already_sent' });
			return { status: 'skipped', reason: 'already_sent' };
		}

		const rendered = renderEmailTemplate(templateKey, {
			userName: user.name,
			unsubscribeUrl,
			deepLinkUrl,
		});

		const sendRow = await this.sendsDB.createQueued({
			userId,
			templateKey,
			campaignKey,
			provider: this.provider.name,
		});

		const headers: Record<string, string> = {};
		if (unsubscribeUrl) {
			headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
			headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
		}

		const idempotencyKey = [userId, templateKey, campaignKey ?? 'default'].join(':');

		try {
			const result = await this.provider.send({
				to: user.email.trim(),
				subject: rendered.subject,
				html: rendered.html,
				text: rendered.text,
				headers: Object.keys(headers).length ? headers : undefined,
				idempotencyKey,
				tags: [
					{ name: 'template_key', value: templateKey },
					...(campaignKey ? [{ name: 'campaign_key', value: campaignKey }] : []),
				],
			});

			await this.sendsDB.markSent(sendRow.id, result.providerMessageId);
			log.info('email_sent', {
				send_id: sendRow.id,
				provider_message_id: result.providerMessageId,
			});

			return {
				status: 'sent',
				sendId: sendRow.id,
				providerMessageId: result.providerMessageId,
			};
		} catch (err) {
			await this.sendsDB.markFailed(sendRow.id);
			log.error('email_send_failed', { send_id: sendRow.id }, err);
			throw err;
		}
	}
}

export const createEmailService = (envBindings: Env = env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({
		service: 'email',
	});
	return new EmailService(
		createUsersDB(envBindings.GOSTYLENS_DB),
		createUserEmailPrefsDB(envBindings.GOSTYLENS_DB),
		new EmailSendsDB(envBindings.GOSTYLENS_DB),
		createEmailProvider(envBindings),
		logger
	);
};
