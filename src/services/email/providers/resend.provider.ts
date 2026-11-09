import { EmailProvider } from './base.provider';
import {
	NormalizedWebhookEvent,
	SendEmailParams,
	SendEmailResult,
} from '../types';
import { verifySvixSignature } from 'utils/svix_webhook.utils';
import {
	normalizeResendWebhookEvent,
	ResendWebhookPayload,
} from './resend_webhook';

const RESEND_API_BASE = 'https://api.resend.com';

type ResendSendResponse = {
	id?: string;
	message?: string;
	name?: string;
};

/**
 * Resend HTTP adapter. Cron / EmailService must not import this directly —
 * resolve via createEmailProvider().
 */
export class ResendProvider implements EmailProvider {
	readonly name = 'resend';

	constructor(
		private apiKey: string,
		private from: string,
		private webhookSecret?: string
	) {}

	async send(params: SendEmailParams): Promise<SendEmailResult> {
		if (!this.apiKey || this.apiKey === 'dummy') {
			throw new Error('RESEND_API_KEY is not configured');
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		};
		if (params.idempotencyKey) {
			headers['Idempotency-Key'] = params.idempotencyKey;
		}

		const res = await fetch(`${RESEND_API_BASE}/emails`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				from: this.from,
				to: [params.to],
				subject: params.subject,
				html: params.html,
				text: params.text,
				headers: params.headers,
				tags: params.tags,
			}),
		});

		const body = (await res.json().catch(() => ({}))) as ResendSendResponse;

		if (!res.ok) {
			const detail = body.message || body.name || res.statusText;
			throw new Error(`Resend send failed (${res.status}): ${detail}`);
		}

		if (!body.id) {
			throw new Error('Resend send succeeded but returned no message id');
		}

		return { providerMessageId: body.id };
	}

	/**
	 * Consent / suppress live in D1. Resend Contacts sync can be added later
	 * without changing EmailService callers.
	 */
	async suppress(_email: string): Promise<void> {
		// no-op for Phase 1 — D1 prefs are source of truth
	}

	async unsuppress(_email: string): Promise<void> {
		// no-op for Phase 1
	}

	async parseWebhook(request: Request): Promise<NormalizedWebhookEvent | null> {
		const payload = await request.text();
		await verifySvixSignature({
			payload,
			svixId: request.headers.get('svix-id') ?? '',
			svixTimestamp: request.headers.get('svix-timestamp') ?? '',
			svixSignature: request.headers.get('svix-signature') ?? '',
			secret: this.webhookSecret ?? '',
		});

		const body = JSON.parse(payload) as ResendWebhookPayload;
		return normalizeResendWebhookEvent(body);
	}
}
