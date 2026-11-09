import { env } from 'cloudflare:workers';
import { createLogger, Logger, serializeError } from './logger.utils';

const DEFAULT_R2_GET_ATTEMPTS = 3;
const DEFAULT_R2_GET_DELAY_MS = 80;
/** Do not stack another get after wrangler has already hung (~38s in local remote R2). */
const R2_RETRY_BUDGET_MS = 12_000;

export type R2ObjectBytes = {
	key: string;
	bytes: ArrayBuffer;
	httpEtag: string;
	httpMetadata?: R2HTTPMetadata;
	writeHttpMetadata: (headers: Headers) => void;
};

/** Wrangler remote R2 + tunnels often throw on get/body, not a clean 404. */
export function isTransientR2Error(err: unknown): boolean {
	const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
	return /unspecified error|network|timeout|abort|econnreset|reset|internal|temporarily|fetch failed|connection|overloaded|hung|429|502|503|504/i.test(
		message,
	);
}

/**
 * `get` + `arrayBuffer` with short retries. Buffering (instead of piping `object.body`)
 * lets the Worker send a complete body with Content-Length, which ngrok/Flutter Image
 * loads tolerate better than a chunked remote-R2 stream.
 *
 * Do not share a get queue or in-flight map across isolate requests: Workers cancel
 * promises resolved from another request context ("code had hung").
 */
export async function getR2ObjectBytes(
	bucket: R2Bucket,
	key: string,
	options: { attempts?: number; delayMs?: number } = {},
): Promise<R2ObjectBytes | null> {
	const attempts = options.attempts ?? DEFAULT_R2_GET_ATTEMPTS;
	const delayMs = options.delayMs ?? DEFAULT_R2_GET_DELAY_MS;
	let lastErr: unknown;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const started = Date.now();
		try {
			const object = await bucket.get(key);
			if (!object) return null;
			const bytes = await object.arrayBuffer();
			return {
				key: object.key,
				bytes,
				httpEtag: object.httpEtag,
				httpMetadata: object.httpMetadata,
				writeHttpMetadata: (headers) => object.writeHttpMetadata(headers),
			};
		} catch (err) {
			lastErr = err;
			const hung = Date.now() - started >= R2_RETRY_BUDGET_MS;
			if (attempt === attempts || hung || !isTransientR2Error(err)) throw err;
			await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
		}
	}

	throw lastErr;
}

/** Buffered image/asset response so proxies see Content-Length instead of a chunked stream. */
export function r2BytesResponse(bytes: ArrayBuffer, headers: Headers): Response {
	headers.set('Content-Length', String(bytes.byteLength));
	return new Response(bytes, { headers });
}

/**
 * Error thrown when an image upload does not complete within the expected timeframe.
 */
export class ImageUploadTimeoutError extends Error {
	constructor(
		public readonly missingKeys: string[],
		public readonly lastErrors?: Record<string, string>
	) {
		const errorDetail =
			lastErrors && Object.keys(lastErrors).length > 0
				? ` Last head errors: ${JSON.stringify(lastErrors)}`
				: '';
		super(`Timeout waiting for images: ${missingKeys.join(', ')}${errorDetail}`);
		this.name = 'ImageUploadTimeoutError';
	}
}

async function headObject(bucket: R2Bucket, key: string): Promise<R2Object | null> {
	let obj = await bucket.head(key);

	if (obj === null && key.includes('%')) {
		const decoded = decodeURIComponent(key);
		if (decoded !== key) {
			obj = await bucket.head(decoded);
		}
	}

	if (obj === null && key.startsWith('/')) {
		const strippedKey = key.slice(1);
		obj = await bucket.head(strippedKey);
		if (obj === null && strippedKey.includes('%')) {
			obj = await bucket.head(decodeURIComponent(strippedKey));
		}
	}

	return obj;
}

/**
 * Polls R2 for the existence of a set of keys.
 *
 * @param bucket The R2 bucket to check
 * @param keys Unique keys to wait for
 * @param options Polling configuration
 */
export async function waitForImages(
	bucket: R2Bucket,
	keys: string[],
	options: { timeoutMs?: number; intervalMs?: number; log?: Logger } = {}
): Promise<void> {
	if (keys.length === 0) return;

	const { timeoutMs = 15000, intervalMs = 1000, log } = options;
	const logger = (log ?? createLogger({ env: env.ENV_NAME })).child({ service: 'r2' });
	const startTime = Date.now();
	const remainingKeys = new Set(keys);
	const lastErrors = new Map<string, string>();
	let pollAttempt = 0;

	while (remainingKeys.size > 0) {
		if (Date.now() - startTime > timeoutMs) {
			const errors = Object.fromEntries(lastErrors);
			throw new ImageUploadTimeoutError(Array.from(remainingKeys), errors);
		}

		pollAttempt += 1;

		const checkPromises = Array.from(remainingKeys).map(async (key) => {
			try {
				const obj = await headObject(bucket, key);

				if (obj !== null) {
					remainingKeys.delete(key);
					lastErrors.delete(key);
					return;
				}

				logger.debug('r2_head_not_found', { key, poll_attempt: pollAttempt });
			} catch (err) {
				const serialized = serializeError(err);
				const message = String(serialized.error_message ?? 'unknown error');
				lastErrors.set(key, message);
				logger.warn('r2_head_failed', { key, poll_attempt: pollAttempt, ...serialized }, err);
			}
		});

		await Promise.all(checkPromises);

		if (remainingKeys.size > 0) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
}
