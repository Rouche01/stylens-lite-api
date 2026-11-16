import { withCfImagesRetry } from '../../utils/cf_images.utils';

/** Soft mint studio pad — dark shoes read clearly; light sneakers still usable. */
export const FOOTWEAR_STUDIO_BG = '#E8F0EE';
export const FOOTWEAR_STUDIO_SIDE = 1024;

/**
 * Non-generative footwear browse face: letterbox real pixels (trusted cutout or padded crop)
 * onto a square studio background. No Nano Banana — avoids label-driven boot hallucinations.
 */
export async function buildFootwearStudioCard(params: {
	images: ImagesBinding;
	/** JPEG crop or PNG cutout bytes. */
	imageBytes: ArrayBuffer;
	source: 'cutout' | 'padded_crop';
	contentType?: string;
}): Promise<{ bytes: Uint8Array; contentType: string; model: string }> {
	const { images, imageBytes, source } = params;
	const inputType = params.contentType || (source === 'cutout' ? 'image/png' : 'image/jpeg');
	const modelBase = source === 'cutout' ? 'studio-cutout' : 'studio-crop';
	try {
		const padded = await withCfImagesRetry(async () => {
			const res = (
				await images
					.input(new Blob([imageBytes], { type: inputType }).stream())
					.transform({
						width: FOOTWEAR_STUDIO_SIDE,
						height: FOOTWEAR_STUDIO_SIDE,
						fit: 'pad',
						background: FOOTWEAR_STUDIO_BG,
					})
					.output({
						format: 'image/jpeg',
						quality: 90,
					})
			).response();
			if (!res.ok || !res.body) {
				throw new Error(`footwear studio pad failed (${res.status})`);
			}
			return res.arrayBuffer();
		});
		return {
			bytes: new Uint8Array(padded),
			contentType: 'image/jpeg',
			model: `${modelBase}-pad`,
		};
	} catch {
		// CF Images pad unavailable / transient — still better than a generative fake boot.
		return {
			bytes: new Uint8Array(imageBytes),
			contentType: inputType,
			model: modelBase,
		};
	}
}
