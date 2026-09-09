import { describe, it, expect } from 'vitest';
import { verifySvixSignature } from '../src/utils/svix_webhook.utils';
import { normalizeResendWebhookEvent } from '../src/services/email/providers/resend_webhook';

async function sign(secretBytes: Uint8Array, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		secretBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
	const bytes = new Uint8Array(sig);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

describe('verifySvixSignature', () => {
	it('accepts a valid signature', async () => {
		const secretRaw = new Uint8Array(32).fill(7);
		const secret = `whsec_${btoa(String.fromCharCode(...secretRaw))}`;
		const id = 'msg_test';
		const ts = String(Math.floor(Date.now() / 1000));
		const payload = '{"type":"email.delivered","data":{"email_id":"abc"}}';
		const sig = await sign(secretRaw, `${id}.${ts}.${payload}`);

		await expect(
			verifySvixSignature({
				payload,
				svixId: id,
				svixTimestamp: ts,
				svixSignature: `v1,${sig}`,
				secret,
			})
		).resolves.toBeUndefined();
	});

	it('rejects a bad signature', async () => {
		const secretRaw = new Uint8Array(32).fill(7);
		const secret = `whsec_${btoa(String.fromCharCode(...secretRaw))}`;
		const ts = String(Math.floor(Date.now() / 1000));

		await expect(
			verifySvixSignature({
				payload: '{}',
				svixId: 'msg_test',
				svixTimestamp: ts,
				svixSignature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
				secret,
			})
		).rejects.toThrow(/Invalid Svix signature/);
	});
});

describe('normalizeResendWebhookEvent', () => {
	it('maps delivered/bounce/open', () => {
		expect(
			normalizeResendWebhookEvent({
				type: 'email.delivered',
				created_at: '2026-01-01T00:00:00.000Z',
				data: { email_id: 'e1', to: ['a@b.com'] },
			})
		).toMatchObject({ providerMessageId: 'e1', status: 'sent' });

		expect(
			normalizeResendWebhookEvent({
				type: 'email.bounced',
				data: { email_id: 'e1', to: ['a@b.com'] },
			})
		).toMatchObject({ status: 'bounced' });

		expect(
			normalizeResendWebhookEvent({
				type: 'email.opened',
				created_at: '2026-01-01T00:00:00.000Z',
				data: { email_id: 'e1' },
			})
		).toMatchObject({ status: 'sent', openedAt: Date.parse('2026-01-01T00:00:00.000Z') });
	});

	it('ignores delayed events', () => {
		expect(
			normalizeResendWebhookEvent({
				type: 'email.delivery_delayed',
				data: { email_id: 'e1' },
			})
		).toBeNull();
	});
});
