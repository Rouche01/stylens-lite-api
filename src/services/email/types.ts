export type EmailProviderName = 'resend';

export type EmailSendStatus =
	| 'queued'
	| 'sent'
	| 'failed'
	| 'bounced'
	| 'complained';

export type SendEmailParams = {
	to: string;
	subject: string;
	html: string;
	text: string;
	headers?: Record<string, string>;
	idempotencyKey?: string;
	tags?: Array<{ name: string; value: string }>;
};

export type SendEmailResult = {
	providerMessageId: string;
};

export type NormalizedWebhookEvent = {
	providerMessageId: string;
	status: EmailSendStatus;
	openedAt?: number;
	clickedAt?: number;
	occurredAt?: number;
	recipientEmails?: string[];
};

export type EmailTemplateKey = 'activation_d0';

export type RenderedEmailTemplate = {
	subject: string;
	html: string;
	text: string;
};
