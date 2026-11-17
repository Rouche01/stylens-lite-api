import { arrayBufferToBase64, fetchImageAsArrayBuffer } from '../../../utils/assets.utils';
import { getImageMimeType } from '../../../utils/image.utils';
import type { Logger } from '../../../utils/logger.utils';
import { FAL_MODELS, FAL_SAM2_MODEL, FalHttpError, falPostJson } from '../../fal';
import { sam3PromptCandidates } from '../sam3_prompt';
import { SegmentError, SegmentProvider, SegmentBoxInput, SegmentBoxResult } from './base.provider';

const SAM2 = FAL_MODELS.segmentSam2;
const SAM3 = FAL_MODELS.segmentSam3;

type FalImage = {
	url?: string;
	content_type?: string;
	file_data?: string;
	data?: string;
	data_uri?: string;
	image_url?: string;
};

type FalSegmentResponse = {
	image?: FalImage | string | FalImage[] | null;
	mask?: FalImage | string | null;
	masks?: Array<FalImage | string> | null;
	images?: Array<FalImage | string> | null;
	scores?: number[] | null;
	detail?: unknown;
	error?: unknown;
};

function asMediaUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined;
	if (value.startsWith('http') || value.startsWith('data:image')) return value;
	return undefined;
}

function falFileToUrl(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === 'string') return asMediaUrl(value);
	if (typeof value !== 'object' || Array.isArray(value)) return undefined;

	const obj = value as FalImage;
	const direct =
		asMediaUrl(obj.url) ?? asMediaUrl(obj.data_uri) ?? asMediaUrl(obj.image_url);
	if (direct) return direct;

	const raw = obj.file_data ?? obj.data;
	if (typeof raw === 'string' && raw.length > 0) {
		if (raw.startsWith('data:')) return raw;
		const mime = obj.content_type || 'image/png';
		return `data:${mime};base64,${raw}`;
	}
	return undefined;
}

function findFalImageUrl(value: unknown, depth = 0): string | undefined {
	if (depth > 6 || value == null) return undefined;
	const fromFile = falFileToUrl(value);
	if (fromFile) return fromFile;
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findFalImageUrl(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		for (const key of ['image', 'mask', 'masks', 'images', 'url', 'file_data', 'data_uri']) {
			if (key in obj) {
				const found = findFalImageUrl(obj[key], depth + 1);
				if (found) return found;
			}
		}
	}
	return undefined;
}

function extractFalImageUrl(json: FalSegmentResponse | null): string | undefined {
	if (!json) return undefined;
	const fromImage = findFalImageUrl(json.image);
	if (fromImage) return fromImage;

	const masks = json.masks;
	if (Array.isArray(masks) && masks.length > 0) {
		const scores = Array.isArray(json.scores) ? json.scores : [];
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < masks.length; i++) {
			if (!findFalImageUrl(masks[i])) continue;
			const score = typeof scores[i] === 'number' ? scores[i] : 0;
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		return findFalImageUrl(masks[bestIdx]) ?? findFalImageUrl(masks);
	}

	return findFalImageUrl(json.mask) ?? findFalImageUrl(json.images) ?? findFalImageUrl(json);
}

function toDataUri(image: ArrayBuffer): string {
	const mime = getImageMimeType(image);
	return `data:${mime};base64,${arrayBufferToBase64(image)}`;
}

/**
 * Fal SAM 2 / SAM 3 adapter. CutoutService must not import this directly — resolve via createSegmentProvider().
 * Box-only → SAM 2. Label → SAM 3 short noun phrases (never Fal's default "wheel").
 * Text + box together when both exist. Empty masks = presence head miss, not a parse error.
 */
export class FalSegmentProvider implements SegmentProvider {
	readonly name = 'fal';
	private activeModel = FAL_SAM2_MODEL;

	get model(): string {
		return this.activeModel;
	}

	constructor(
		private apiKey: string,
		private log?: Logger
	) {}

	async segmentBox(input: SegmentBoxInput): Promise<SegmentBoxResult> {
		if (!this.apiKey?.trim()) {
			throw new SegmentError('FAL_KEY is not set');
		}

		const label = input.label?.trim();
		const boxPx = input.boxPx;
		if (!label && !boxPx) {
			throw new SegmentError('segmentBox requires label and/or boxPx');
		}

		const imageUrl = input.imageUrl || toDataUri(input.image);
		const useSam3 = Boolean(label);
		if (!useSam3 && !boxPx) {
			throw new SegmentError('SAM 2 requires boxPx; pass a label to use SAM 3 without a box');
		}

		const prompts = label ? sam3PromptCandidates(label) : [];
		if (label && prompts.length === 0) {
			throw new SegmentError('SAM 3 prompt is empty after normalizing the label');
		}

		const signal = input.signal;

		// Face / crop path: box-guided SAM 2 first so wrong SAM 3 concepts cannot win.
		if (input.preferBoxFirst && boxPx) {
			this.activeModel = SAM2.model;
			const sam2 = await this.runFal({
				endpoint: SAM2.endpoint,
				model: this.activeModel,
				imageUrl,
				boxPx,
				centerPoint: true,
				signal,
			});
			if (sam2) {
				return {
					pngBytes: sam2.pngBytes,
					model: this.activeModel,
					promptUsed: '',
					promptsTried: prompts,
					maskScore: sam2.maskScore,
				};
			}
		}

		if (useSam3) {
			this.activeModel = SAM3.model;
			for (const prompt of prompts) {
				const sam3 = await this.runFal({
					endpoint: SAM3.endpoint,
					model: this.activeModel,
					imageUrl,
					boxPx,
					prompt,
					signal,
				});
				if (sam3) {
					return {
						pngBytes: sam3.pngBytes,
						model: this.activeModel,
						promptUsed: prompt,
						promptsTried: prompts,
						maskScore: sam3.maskScore,
					};
				}
			}

			if (boxPx && !input.preferBoxFirst) {
				this.activeModel = SAM2.model;
				const sam2 = await this.runFal({
					endpoint: SAM2.endpoint,
					model: this.activeModel,
					imageUrl,
					boxPx,
					centerPoint: true,
					signal,
				});
				if (sam2) {
					return {
						pngBytes: sam2.pngBytes,
						model: this.activeModel,
						promptUsed: '',
						promptsTried: prompts,
						maskScore: sam2.maskScore,
					};
				}
			}

			throw new SegmentError(
				`SAM 3 found no matching concept (empty masks). Tried: ${prompts.join(', ')}. Use a short noun phrase (e.g. "green jacket") and/or a tight boundingBox — text+box is the supported garment path.`,
				422
			);
		}

		this.activeModel = SAM2.model;
		const sam2 = await this.runFal({
			endpoint: SAM2.endpoint,
			model: this.activeModel,
			imageUrl,
			boxPx,
			centerPoint: true,
			signal,
		});
		if (!sam2) {
			throw new SegmentError(`${FAL_SAM2_MODEL} returned no mask image`, 422);
		}
		return {
			pngBytes: sam2.pngBytes,
			model: this.activeModel,
			maskScore: sam2.maskScore,
		};
	}

	private async runFal(params: {
		endpoint: string;
		model: string;
		imageUrl: string;
		boxPx?: SegmentBoxInput['boxPx'];
		prompt?: string;
		centerPoint?: boolean;
		signal?: AbortSignal;
	}): Promise<{ pngBytes: Uint8Array; maskScore?: number } | null> {
		const payload: Record<string, unknown> = {
			image_url: params.imageUrl,
			apply_mask: true,
			output_format: 'png',
		};
		if (params.boxPx) {
			const [x1, y1, x2, y2] = params.boxPx;
			payload.box_prompts = [{ x_min: x1, y_min: y1, x_max: x2, y_max: y2, object_id: 0 }];
			if (params.centerPoint) {
				const cx = Math.round((x1 + x2) / 2);
				const cy = Math.round((y1 + y2) / 2);
				payload.prompts = [{ x: cx, y: cy, label: 1 }];
			}
		}
		if (params.prompt) {
			payload.prompt = params.prompt;
			payload.return_multiple_masks = true;
			payload.max_masks = 3;
			payload.include_scores = true;
		}

		let json: FalSegmentResponse;
		try {
			const result = await falPostJson<FalSegmentResponse>({
				apiKey: this.apiKey,
				endpoint: params.endpoint,
				model: params.model,
				useCase: 'segment',
				log: this.log,
				signal: params.signal,
				body: payload,
			});
			json = result.json;
		} catch (err) {
			if (err instanceof FalHttpError) {
				throw new SegmentError(err.message, err.status);
			}
			throw err;
		}

		const picked = pickFalMask(json);
		if (!picked?.url) return null;

		const pngBuffer = await fetchImageAsArrayBuffer(picked.url);
		return { pngBytes: new Uint8Array(pngBuffer), maskScore: picked.score };
	}
}

function pickFalMask(json: FalSegmentResponse | null): { url: string; score?: number } | null {
	if (!json) return null;

	const masks = json.masks;
	if (Array.isArray(masks) && masks.length > 0) {
		const scores = Array.isArray(json.scores) ? json.scores : [];
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < masks.length; i++) {
			if (!findFalImageUrl(masks[i])) continue;
			const score = typeof scores[i] === 'number' ? scores[i] : 0;
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		const url = findFalImageUrl(masks[bestIdx]) ?? findFalImageUrl(masks);
		if (!url) return null;
		return {
			url,
			score: Number.isFinite(bestScore) && bestScore !== Number.NEGATIVE_INFINITY ? bestScore : undefined,
		};
	}

	const url = extractFalImageUrl(json);
	if (!url) return null;
	const scores = Array.isArray(json.scores) ? json.scores : [];
	const score = typeof scores[0] === 'number' ? scores[0] : undefined;
	return { url, score };
}
