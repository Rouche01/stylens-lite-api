import { EmailProvider } from './base.provider';
import {
	NormalizedWebhookEvent,
	SendEmailParams,
	SendEmailResult,
} from '../types';

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
		private from: string
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
		// no-op for Phase 0/1
	}

	async unsuppress(_email: string): Promise<void> {
		// no-op for Phase 0/1
	}

	async parseWebhook(_request: Request): Promise<NormalizedWebhookEvent | null> {
		// Wired in esp-webhooks todo
		return null;
	}
}
