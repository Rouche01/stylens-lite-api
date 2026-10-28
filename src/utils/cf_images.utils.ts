import { ImageTrim } from './bounding_box';

export async function orientImageJpeg(images: ImagesBinding, bytes: ArrayBuffer): Promise<ArrayBuffer> {
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
}
