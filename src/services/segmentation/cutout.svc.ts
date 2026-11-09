import { signDownloadUrlForKey } from '../../utils/assets.utils';
import { getImageDimensions } from '../../utils/image.utils';
import { Logger, createLogger } from '../../utils/logger.utils';
import { BoxPx, SegmentProvider, createSegmentProvider } from './providers';

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
		});

		return {
			pngBytes: segmented.pngBytes,
			imageKey,
			boxPx: boxPx ?? null,
			imageDimensions,
			model: segmented.model,
			promptUsed: segmented.promptUsed,
			promptsTried: segmented.promptsTried,
		};
	}
}

export const createCutoutService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'cutout' });
	return new CutoutService(
		createSegmentProvider(envBindings),
		envBindings.OUTFIT_PHOTOS_BUCKET,
		logger
	);
};
