import { ImageTrim } from './bounding_box';

/** Transient CF Images failures (e.g. 1031 / 5xx) get one immediate retry. */
export const CF_IMAGES_RETRY_ATTEMPTS = 2;

export function isRetryableCfImagesFailure(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	if (/\b1031\b/.test(message)) return true;
	const statusMatch = message.match(/\((\d{3})\)/);
	if (statusMatch) {
		const status = Number(statusMatch[1]);
		return status >= 500 || status === 429;
	}
	// Network / abort-style messages without an HTTP status.
	return /fetch failed|network|timed?\s*out|ECONNRESET|socket/i.test(message);
}

async function withCfImagesRetry<T>(op: () => Promise<T>): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= CF_IMAGES_RETRY_ATTEMPTS; attempt++) {
		try {
			return await op();
		} catch (err) {
			lastErr = err;
			if (attempt >= CF_IMAGES_RETRY_ATTEMPTS || !isRetryableCfImagesFailure(err)) {
				throw err;
			}
		}
	}
	throw lastErr;
}

export async function orientImageJpeg(images: ImagesBinding, bytes: ArrayBuffer): Promise<ArrayBuffer> {
	return withCfImagesRetry(async () => {
		const oriented = (
			await images.input(new Blob([bytes]).stream()).output({
				format: 'image/jpeg',
				quality: 90,
			})
		).response();

		if (!oriented.ok || !oriented.body) {
			throw new Error(`Failed to orient outfit image (${oriented.status})`);
		}

		return oriented.arrayBuffer();
	});
}

/** Bake EXIF, then trim. Compute `trim` with `percentBoxToTrim` on the same pixel size. */
export async function cropJpegWithTrim(
	images: ImagesBinding,
	bytes: ArrayBuffer,
	trim: ImageTrim,
	cropQuality = 85,
	options?: { alreadyOriented?: boolean }
): Promise<ArrayBuffer> {
	const source = options?.alreadyOriented ? bytes : await orientImageJpeg(images, bytes);
	return withCfImagesRetry(async () => {
		const cropped = (
			await images.input(new Blob([source]).stream()).transform({ trim }).output({
				format: 'image/jpeg',
				quality: cropQuality,
			})
		).response();

		if (!cropped.ok) {
			throw new Error(`Failed to crop outfit image (${cropped.status})`);
		}

		return cropped.arrayBuffer();
	});
}

/** Shrink so the longest side is at most `maxSide` (no upscale). */
export async function resizeJpegMaxSide(
	images: ImagesBinding,
	bytes: ArrayBuffer,
	maxSide: number,
	quality = 85
): Promise<ArrayBuffer> {
	if (!Number.isFinite(maxSide) || maxSide <= 0) {
		return bytes;
	}
	return withCfImagesRetry(async () => {
		const resized = (
			await images
				.input(new Blob([bytes]).stream())
				.transform({ width: maxSide, height: maxSide, fit: 'scale-down' })
				.output({
					format: 'image/jpeg',
					quality,
				})
		).response();

		if (!resized.ok || !resized.body) {
			throw new Error(`Failed to resize image (${resized.status})`);
		}

		return resized.arrayBuffer();
	});
}
