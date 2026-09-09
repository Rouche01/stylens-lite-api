/**
 * Svix / Standard Webhooks signature verification (Web Crypto).
 * Used by Resend webhooks — raw body must be verified unchanged.
 */

const DEFAULT_TOLERANCE_SEC = 5 * 60;

function decodeSecret(secret: string): Uint8Array {
	const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
	const bin = atob(raw);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/**
 * Verifies `svix-id` / `svix-timestamp` / `svix-signature` against the raw payload.
 * Throws on failure.
 */
export async function verifySvixSignature(params: {
	payload: string;
	svixId: string;
	svixTimestamp: string;
	svixSignature: string;
	secret: string;
	toleranceSec?: number;
}): Promise<void> {
	const { payload, svixId, svixTimestamp, svixSignature, secret } = params;
	const tolerance = params.toleranceSec ?? DEFAULT_TOLERANCE_SEC;

	if (!secret || secret === 'dummy') {
		throw new Error('Webhook secret is not configured');
	}
	if (!svixId || !svixTimestamp || !svixSignature) {
		throw new Error('Missing Svix signature headers');
	}

	const ts = Number(svixTimestamp);
	if (!Number.isFinite(ts)) {
		throw new Error('Invalid Svix timestamp');
	}
	const nowSec = Math.floor(Date.now() / 1000);
	if (Math.abs(nowSec - ts) > tolerance) {
		throw new Error('Svix timestamp outside tolerance');
	}

	const key = await crypto.subtle.importKey(
		'raw',
		decodeSecret(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const toSign = new TextEncoder().encode(`${svixId}.${svixTimestamp}.${payload}`);
	const sigBuf = await crypto.subtle.sign('HMAC', key, toSign);
	const expected = new Uint8Array(sigBuf);

	const candidates = svixSignature.split(' ').flatMap((part) => {
		const [version, value] = part.split(',', 2);
		if (version !== 'v1' || !value) return [];
		return [value];
	});

	for (const candidate of candidates) {
		try {
			if (timingSafeEqual(expected, base64ToBytes(candidate))) {
				return;
			}
		} catch {
			// ignore malformed base64
		}
	}

	throw new Error('Invalid Svix signature');
}
