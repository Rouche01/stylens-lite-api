import { EmailSendStatus, NormalizedWebhookEvent } from '../types';

export type ResendWebhookPayload = {
	type: string;
	created_at?: string;
	data?: {
		email_id?: string;
		to?: string[];
		created_at?: string;
		[key: string]: unknown;
	};
};

/** Map Resend event → normalized send update, or null if ignored. */
export function normalizeResendWebhookEvent(
	payload: ResendWebhookPayload
): NormalizedWebhookEvent | null {
	const emailId = payload.data?.email_id;
	if (!emailId) return null;

	const occurredAt = payload.created_at
		? Date.parse(payload.created_at)
		: Date.now();
	const at = Number.isFinite(occurredAt) ? occurredAt : Date.now();
	const to = payload.data?.to?.filter((e) => typeof e === 'string' && e.includes('@'));

	const base = {
		providerMessageId: emailId,
		occurredAt: at,
		...(to?.length ? { recipientEmails: to } : {}),
	};

	switch (payload.type) {
		case 'email.sent':
		case 'email.delivered':
			return { ...base, status: 'sent' satisfies EmailSendStatus };
		case 'email.bounced':
			return { ...base, status: 'bounced' };
		case 'email.complained':
			return { ...base, status: 'complained' };
		case 'email.failed':
		case 'email.suppressed':
			return { ...base, status: 'failed' };
		case 'email.opened':
			return { ...base, status: 'sent', openedAt: at };
		case 'email.clicked':
			return { ...base, status: 'sent', clickedAt: at };
		default:
			return null;
	}
}
