import { env } from 'cloudflare:workers';
import { EmailProvider } from './base.provider';
import { ResendProvider } from './resend.provider';

export function createEmailProvider(envBindings: Env = env): EmailProvider {
	const name = (envBindings.EMAIL_PROVIDER || 'resend').toLowerCase();

	switch (name) {
		case 'resend':
			return new ResendProvider(
				envBindings.RESEND_API_KEY,
				envBindings.EMAIL_FROM,
				envBindings.RESEND_WEBHOOK_SECRET
			);
		default:
			throw new Error(`Unsupported EMAIL_PROVIDER: ${name}`);
	}
}
