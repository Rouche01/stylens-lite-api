import { cropJpegWithTrim, orientImageJpeg } from '../../utils/cf_images.utils';
import { percentBoxToTrim } from '../../utils/bounding_box';
import { signDownloadUrlForKey } from '../../utils/assets.utils';
import { getImageDimensions } from '../../utils/image.utils';
import { Logger, createLogger } from '../../utils/logger.utils';
import { BoxPx, SegmentProvider, createSegmentProvider } from './providers';
import {
	cropLocalBoxPx,
	evaluateFaceCutoutPng,
	FACE_FOOTWEAR_MIN_CROP_SIDE,
	faceCutoutPad,
	facePrefersSam3First,
	faceQualityRank,
	isFootwearCategory,
	passesFaceQuality,
	type FaceQualityMetrics,
	type FaceQualityVerdict,
} from './face_quality';

export type PercentBox = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type CutoutFromR2Params = {
	imageKey: string;
	boundingBox?: PercentBox;
	/** Extract item label; with Fal this uses SAM 3 (concept; box optional). */
	label?: string;
};

export type CutoutResult = {
	pngBytes: Uint8Array;
	imageKey: string;
	boxPx: BoxPx | null;
	imageDimensions: { width: number; height: number };
	model: string;
	promptUsed?: string;
	promptsTried?: string[];
	maskScore?: number;
};

export type FaceCutoutFromR2Params = CutoutFromR2Params & {
	/** Closet category for pad (footwear/accessory tightened). */
	category?: string | null;
};

export type FaceCutoutResult = CutoutResult & {
	quality: FaceQualityMetrics;
	verdict: FaceQualityVerdict;
	cropImageKey: string;
};

/**
 * Small pad so sleeves/hems stay in-box without swallowing walls (off-center elevator shots).
 */
export function percentBoxToPaddedXyxy(
	box: PercentBox,
	imgW: number,
	imgH: number
): BoxPx {
	const padW = Math.max(0.5, Math.min(2, box.width * 0.04));
	const padH = Math.max(0.5, Math.min(2, box.height * 0.04));

	const paddedX = Math.max(0, box.x - padW);
	const paddedY = Math.max(0, box.y - padH);
	const paddedW = Math.min(100 - paddedX, box.width + padW * 2);
	const paddedH = Math.min(100 - paddedY, box.height + padH * 2);

	const x1 = Math.round((paddedX / 100) * imgW);
	const y1 = Math.round((paddedY / 100) * imgH);
	const x2 = Math.round(((paddedX + paddedW) / 100) * imgW);
	const y2 = Math.round(((paddedY + paddedH) / 100) * imgH);

	return [
		Math.max(0, Math.min(imgW - 1, x1)),
		Math.max(0, Math.min(imgH - 1, y1)),
		Math.max(1, Math.min(imgW, x2)),
		Math.max(1, Math.min(imgH, y2)),
	];
}

export class CutoutService {
	constructor(
		private provider: SegmentProvider,
		private bucket: R2Bucket,
		private images: ImagesBinding,
		private log: Logger
	) {}

	async cutoutFromR2(params: CutoutFromR2Params): Promise<CutoutResult> {
		const { imageKey, boundingBox, label } = params;
		const log = this.log.child({ image_key: imageKey, provider: this.provider.name });

		if (!label?.trim() && !boundingBox) {
			throw new Error('label and/or boundingBox is required');
		}

		const object = await this.bucket.get(imageKey);
		if (!object) {
			throw new Error(`Outfit image not found in R2: ${imageKey}`);
		}

		const image = await object.arrayBuffer();
		const imageDimensions = await getImageDimensions(image);
		const boxPx = boundingBox
			? percentBoxToPaddedXyxy(boundingBox, imageDimensions.width, imageDimensions.height)
			: undefined;

		if (boxPx && (boxPx[2] <= boxPx[0] || boxPx[3] <= boxPx[1])) {
			throw new Error(`Invalid padded box ${boxPx.join(',')} for image ${imageDimensions.width}x${imageDimensions.height}`);
		}

		log.info('cutout_segment_start', {
			box_px: boxPx ? boxPx.join(',') : '',
			image_width: imageDimensions.width,
			image_height: imageDimensions.height,
			label: label || '',
			model: label ? 'fal-ai/sam-3/image' : this.provider.model,
		});

		const segmented = await this.provider.segmentBox({
			image,
			boxPx,
			imageUrl: await signDownloadUrlForKey(imageKey),
			label,
		});

		log.info('cutout_segment_ok', {
			bytes: segmented.pngBytes.byteLength,
			model: segmented.model,
			prompt_used: segmented.promptUsed || '',
			prompts_tried: (segmented.promptsTried || []).join('|'),
			mask_score: segmented.maskScore ?? null,
		});

		return {
			pngBytes: segmented.pngBytes,
			imageKey,
			boxPx: boxPx ?? null,
			imageDimensions,
			model: segmented.model,
			promptUsed: segmented.promptUsed,
			promptsTried: segmented.promptsTried,
			maskScore: segmented.maskScore,
		};
	}

	/**
	 * Padded garment crop only (no SAM) — packshot fallback when cutout is missing/rejected.
	 */
	async cropFaceJpegFromR2(params: FaceCutoutFromR2Params): Promise<{
		cropImageKey: string;
		cropJpeg: ArrayBuffer;
		cropWidth: number;
		cropHeight: number;
	}> {
		const { imageKey, boundingBox, category } = params;
		if (!boundingBox) {
			throw new Error('cropFaceJpegFromR2 requires boundingBox');
		}

		const object = await this.bucket.get(imageKey);
		if (!object) {
			throw new Error(`Outfit image not found in R2: ${imageKey}`);
		}

		const raw = await object.arrayBuffer();
		// Match identity/catalog: orient first, then trim on oriented pixel size (EXIF swap).
		const oriented = await orientImageJpeg(this.images, raw);
		const fullDims = await getImageDimensions(oriented);
		const trim = percentBoxToTrim(boundingBox, fullDims.width, fullDims.height, faceCutoutPad(category));
		const cropJpeg = await cropJpegWithTrim(this.images, oriented, trim, 85, { alreadyOriented: true });
		const cropDims = await getImageDimensions(cropJpeg);

		const cropImageKey = `cutouts/scratch/face-crop-${crypto.randomUUID()}.jpg`;
		await this.bucket.put(cropImageKey, cropJpeg, {
			httpMetadata: { contentType: 'image/jpeg' },
		});
		return {
			cropImageKey,
			cropJpeg,
			cropWidth: cropDims.width,
			cropHeight: cropDims.height,
		};
	}

	/**
	 * Crop-then-SAM face path: padded crop → SAM2 box-first on crop → quality gate.
	 * On quality fail with a label, retries SAM3 on the same crop. Does not discard closet items.
	 */
	async cutoutFaceFromR2(params: FaceCutoutFromR2Params): Promise<FaceCutoutResult> {
		const { imageKey, boundingBox, label, category } = params;
		const log = this.log.child({ image_key: imageKey, provider: this.provider.name, face: true });

		if (!boundingBox) {
			throw new Error('cutoutFaceFromR2 requires boundingBox');
		}

		const cropped = await this.cropFaceJpegFromR2(params);
		const cropImageKey = cropped.cropImageKey;
		const cropJpeg = cropped.cropJpeg;
		const cropDims = { width: cropped.cropWidth, height: cropped.cropHeight };
		const cropUrl = await signDownloadUrlForKey(cropImageKey);
		const localBox = cropLocalBoxPx(cropDims.width, cropDims.height);

		log.info('cutout_face_crop_ok', {
			crop_image_key: cropImageKey,
			crop_width: cropDims.width,
			crop_height: cropDims.height,
			label: label || '',
			category: category || '',
		});

		if (
			isFootwearCategory(category) &&
			Math.min(cropDims.width, cropDims.height) < FACE_FOOTWEAR_MIN_CROP_SIDE
		) {
			const quality = {
				width: cropDims.width,
				height: cropDims.height,
				opaqueFrac: 0,
				opaqueBboxFrac: 0,
				meanLuma: 0,
				lumaStd: 0,
				fillDensity: 0,
				maskScore: null,
			};
			log.info('cutout_face_crop_too_small', {
				min_side: Math.min(cropDims.width, cropDims.height),
				required: FACE_FOOTWEAR_MIN_CROP_SIDE,
			});
			return {
				pngBytes: new Uint8Array(0),
				imageKey,
				boxPx: localBox,
				imageDimensions: cropDims,
				model: 'crop-size-gate',
				quality,
				verdict: {
					ok: false,
					reason: `footwear_crop_side ${Math.min(cropDims.width, cropDims.height)} < ${FACE_FOOTWEAR_MIN_CROP_SIDE}`,
					metrics: quality,
				},
				cropImageKey,
			};
		}

		const trySegment = async (preferBoxFirst: boolean) => {
			log.info('cutout_face_segment_start', {
				prefer_box_first: preferBoxFirst,
				box_px: localBox.join(','),
				label: label || '',
				category: category || '',
			});
			const segmented = await this.provider.segmentBox({
				image: cropJpeg,
				boxPx: localBox,
				imageUrl: cropUrl,
				label,
				preferBoxFirst,
			});
			const quality = await evaluateFaceCutoutPng(segmented.pngBytes, segmented.maskScore ?? null);
			const verdict = passesFaceQuality(quality, { category });
			log.info('cutout_face_segment_ok', {
				bytes: segmented.pngBytes.byteLength,
				model: segmented.model,
				prompt_used: segmented.promptUsed || '',
				prompts_tried: (segmented.promptsTried || []).join('|'),
				mask_score: segmented.maskScore ?? null,
				opaque_frac: Number(quality.opaqueFrac.toFixed(4)),
				opaque_bbox_frac: Number(quality.opaqueBboxFrac.toFixed(4)),
				mean_luma: Number(quality.meanLuma.toFixed(1)),
				luma_std: Number(quality.lumaStd.toFixed(1)),
				fill_density: Number(quality.fillDensity.toFixed(4)),
				quality_ok: verdict.ok,
				quality_reason: verdict.reason,
			});
			return { segmented, quality, verdict };
		};

		// Footwear/accessory: SAM3 concept first — box-first SAM2 often yields black voids / person blobs.
		const sam3First = facePrefersSam3First(category) && Boolean(label?.trim());
		const firstPreferBox = !sam3First;
		let best = await trySegment(firstPreferBox);
		if (!best.verdict.ok && label?.trim()) {
			log.info('cutout_face_retry_alt', {
				reason: best.verdict.reason,
				next_prefer_box_first: sam3First,
			});
			try {
				const retry = await trySegment(sam3First);
				if (
					retry.verdict.ok ||
					(!best.verdict.ok && faceQualityRank(retry.quality) > faceQualityRank(best.quality))
				) {
					best = retry;
				}
			} catch (err) {
				log.warn('cutout_face_alt_retry_failed', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return {
			pngBytes: best.segmented.pngBytes,
			imageKey,
			boxPx: localBox,
			imageDimensions: cropDims,
			model: best.segmented.model,
			promptUsed: best.segmented.promptUsed,
			promptsTried: best.segmented.promptsTried,
			maskScore: best.segmented.maskScore,
			quality: best.quality,
			verdict: best.verdict,
			cropImageKey,
		};
	}
}

export const createCutoutService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'cutout' });
	return new CutoutService(
		createSegmentProvider(envBindings, logger),
		envBindings.OUTFIT_PHOTOS_BUCKET,
		envBindings.IMAGES,
		logger
	);
};
