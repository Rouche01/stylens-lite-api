import { SignJWT, jwtVerify } from 'jose';

const UNSUBSCRIBE_AUD = 'email-unsubscribe';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

function secretKey(secret: string): Uint8Array {
	return new TextEncoder().encode(secret);
}

export async function signUnsubscribeToken(
	userId: string,
	secret: string,
	ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string> {
	if (!secret || secret === 'dummy') {
		throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not configured');
	}

	return new SignJWT({ sub: userId, purpose: 'marketing_unsubscribe' })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience(UNSUBSCRIBE_AUD)
		.setIssuedAt()
		.setExpirationTime(`${ttlSeconds}s`)
		.sign(secretKey(secret));
}

export async function verifyUnsubscribeToken(
	token: string,
	secret: string
): Promise<{ userId: string }> {
	if (!secret || secret === 'dummy') {
		throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not configured');
	}

	const { payload } = await jwtVerify(token, secretKey(secret), {
		audience: UNSUBSCRIBE_AUD,
		algorithms: ['HS256'],
	});

	const userId = payload.sub;
	if (!userId || typeof userId !== 'string') {
		throw new Error('Invalid unsubscribe token');
	}

	return { userId };
}

export async function buildUnsubscribeUrl(params: {
	baseUrl: string;
	userId: string;
	secret: string;
}): Promise<string> {
	const token = await signUnsubscribeToken(params.userId, params.secret);
	const base = params.baseUrl.replace(/\/$/, '');
	return `${base}/email/unsubscribe?token=${encodeURIComponent(token)}`;
}
