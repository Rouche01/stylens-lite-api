import { describe, it, expect } from 'vitest';
import {
	signUnsubscribeToken,
	verifyUnsubscribeToken,
	buildUnsubscribeUrl,
} from '../src/utils/email_unsubscribe.utils';

describe('email unsubscribe tokens', () => {
	const secret = 'test-unsubscribe-secret-not-dummy';

	it('round-trips userId', async () => {
		const token = await signUnsubscribeToken('user-123', secret);
		const { userId } = await verifyUnsubscribeToken(token, secret);
		expect(userId).toBe('user-123');
	});

	it('rejects wrong secret', async () => {
		const token = await signUnsubscribeToken('user-123', secret);
		await expect(verifyUnsubscribeToken(token, 'other-secret-xxxxxxxx')).rejects.toThrow();
	});

	it('builds unsubscribe URL', async () => {
		const url = await buildUnsubscribeUrl({
			baseUrl: 'https://api.example.com/',
			userId: 'user-123',
			secret,
		});
		expect(url.startsWith('https://api.example.com/email/unsubscribe?token=')).toBe(true);
		const token = new URL(url).searchParams.get('token')!;
		const { userId } = await verifyUnsubscribeToken(token, secret);
		expect(userId).toBe('user-123');
	});
});
