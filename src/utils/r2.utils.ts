/**
 * Error thrown when an image upload does not complete within the expected timeframe.
 */
export class ImageUploadTimeoutError extends Error {
	constructor(public readonly missingKeys: string[]) {
		super(`Timeout waiting for images: ${missingKeys.join(', ')}`);
		this.name = 'ImageUploadTimeoutError';
	}
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
	options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
	if (keys.length === 0) return;

	const { timeoutMs = 15000, intervalMs = 1000 } = options;
	const startTime = Date.now();
	const remainingKeys = new Set(keys);

	while (remainingKeys.size > 0) {
		if (Date.now() - startTime > timeoutMs) {
			throw new ImageUploadTimeoutError(Array.from(remainingKeys));
		}

		const checkPromises = Array.from(remainingKeys).map(async (key) => {
			try {
				const obj = await bucket.head(key);
				if (obj !== null) {
					remainingKeys.delete(key);
				}
			} catch (err) {
				// Ignore errors during head check (e.g. transient network issues)
				console.warn(`Error checking R2 key "${key}":`, err);
			}
		});

		await Promise.all(checkPromises);

		if (remainingKeys.size > 0) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
}
