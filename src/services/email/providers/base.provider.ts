import {
	NormalizedWebhookEvent,
	SendEmailParams,
	SendEmailResult,
} from '../types';

export interface EmailProvider {
	readonly name: string;

	send(params: SendEmailParams): Promise<SendEmailResult>;

	/** Optional ESP-side suppression; D1 remains source of truth for consent. */
	suppress?(email: string): Promise<void>;

	unsuppress?(email: string): Promise<void>;

	parseWebhook?(request: Request): Promise<NormalizedWebhookEvent | null>;
}
