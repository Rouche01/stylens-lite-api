import { withCfImagesRetry } from '../../utils/cf_images.utils';
import {
	PACKSHOT_BG_FOR_DARK_GARMENT,
	resolvePackshotStudioBackground,
} from '../../utils/packshot_background';

/** @deprecated Prefer resolvePackshotStudioBackground — default mint for dark garments. */
export const FOOTWEAR_STUDIO_BG = PACKSHOT_BG_FOR_DARK_GARMENT;
export const FOOTWEAR_STUDIO_SIDE = 1024;

/**
 * Non-generative footwear browse face: letterbox real pixels (trusted cutout or padded crop)
 * onto a square studio background. Background swatch contrasts the garment (mint vs charcoal).
 */
export async function buildFootwearStudioCard(params: {
	images: ImagesBinding;
	/** JPEG crop or PNG cutout bytes. */
	imageBytes: ArrayBuffer;
	source: 'cutout' | 'padded_crop';
	contentType?: string;
	/** Extract color — picks mint vs charcoal pad. */
	color?: string | null;
	/** Optional opaque mean luma when color is ambiguous. */
	meanLuma?: number | null;
}): Promise<{ bytes: Uint8Array; contentType: string; model: string; background: string }> {
	const { images, imageBytes, source } = params;
	const inputType = params.contentType || (source === 'cutout' ? 'image/png' : 'image/jpeg');
	const modelBase = source === 'cutout' ? 'studio-cutout' : 'studio-crop';
	const bg = resolvePackshotStudioBackground({ color: params.color, meanLuma: params.meanLuma });
	try {
		const padded = await withCfImagesRetry(async () => {
			const res = (
				await images
					.input(new Blob([imageBytes], { type: inputType }).stream())
					.transform({
						width: FOOTWEAR_STUDIO_SIDE,
						height: FOOTWEAR_STUDIO_SIDE,
						fit: 'pad',
						background: bg.hex,
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
			background: bg.hex,
		};
	} catch {
		// CF Images pad unavailable / transient — still better than a generative fake boot.
		return {
			bytes: new Uint8Array(imageBytes),
			contentType: inputType,
			model: modelBase,
			background: bg.hex,
		};
	}
}
