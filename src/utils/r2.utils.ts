import { env } from 'cloudflare:workers';
import { createLogger, Logger, serializeError } from './logger.utils';

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
