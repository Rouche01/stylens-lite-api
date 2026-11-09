import { arrayBufferToBase64, fetchImageAsArrayBuffer } from '../../../utils/assets.utils';
import { getImageMimeType } from '../../../utils/image.utils';
import { sam3PromptCandidates } from '../sam3_prompt';
import { SegmentError, SegmentProvider, SegmentBoxInput, SegmentBoxResult } from './base.provider';

const FAL_SAM2_ENDPOINT = 'https://fal.run/fal-ai/sam2/image';
const FAL_SAM3_ENDPOINT = 'https://fal.run/fal-ai/sam-3/image';

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

function summarizeFalError(body: string, json: FalSegmentResponse | null): string {
	if (json?.detail != null) {
		return typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail).slice(0, 500);
	}
	if (json?.error != null) {
		return typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 500);
	}
	return body.slice(0, 500);
}

/**
 * Fal SAM 2 / SAM 3 adapter. CutoutService must not import this directly — resolve via createSegmentProvider().
 * Box-only → SAM 2. Label → SAM 3 short noun phrases (never Fal's default "wheel").
 * Text + box together when both exist. Empty masks = presence head miss, not a parse error.
 */
export class FalSegmentProvider implements SegmentProvider {
	readonly name = 'fal';
	private activeModel = 'fal-ai/sam2/image';

	get model(): string {
		return this.activeModel;
	}

	constructor(private apiKey: string) {}

	async segmentBox(input: SegmentBoxInput): Promise<SegmentBoxResult> {
		if (!this.apiKey) {
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

		if (useSam3) {
			const prompts = sam3PromptCandidates(label as string);
			if (prompts.length === 0) {
				throw new SegmentError('SAM 3 prompt is empty after normalizing the label');
			}

			this.activeModel = 'fal-ai/sam-3/image';
			for (const prompt of prompts) {
				const pngBytes = await this.runFal({
					endpoint: FAL_SAM3_ENDPOINT,
					model: this.activeModel,
					imageUrl,
					boxPx,
					prompt,
				});
				if (pngBytes) {
					return {
						pngBytes,
						model: this.activeModel,
						promptUsed: prompt,
						promptsTried: prompts,
					};
				}
			}

			if (boxPx) {
				this.activeModel = 'fal-ai/sam2/image';
				const pngBytes = await this.runFal({
					endpoint: FAL_SAM2_ENDPOINT,
					model: this.activeModel,
					imageUrl,
					boxPx,
				});
				if (pngBytes) {
					return {
						pngBytes,
						model: this.activeModel,
						promptUsed: '',
						promptsTried: prompts,
					};
				}
			}

			throw new SegmentError(
				`SAM 3 found no matching concept (empty masks). Tried: ${prompts.join(', ')}. Use a short noun phrase (e.g. "green jacket") and/or a tight boundingBox — text+box is the supported garment path.`,
				422
			);
		}

		this.activeModel = 'fal-ai/sam2/image';
		const pngBytes = await this.runFal({
			endpoint: FAL_SAM2_ENDPOINT,
			model: this.activeModel,
			imageUrl,
			boxPx,
		});
		if (!pngBytes) {
			throw new SegmentError('fal-ai/sam2/image returned no mask image', 422);
		}
		return { pngBytes, model: this.activeModel };
	}

	private async runFal(params: {
		endpoint: string;
		model: string;
		imageUrl: string;
		boxPx?: SegmentBoxInput['boxPx'];
		prompt?: string;
	}): Promise<Uint8Array | null> {
		const payload: Record<string, unknown> = {
			image_url: params.imageUrl,
			apply_mask: true,
			output_format: 'png',
		};
		if (params.boxPx) {
			const [x1, y1, x2, y2] = params.boxPx;
			payload.box_prompts = [{ x_min: x1, y_min: y1, x_max: x2, y_max: y2, object_id: 0 }];
		}
		if (params.prompt) {
			payload.prompt = params.prompt;
			payload.return_multiple_masks = true;
			payload.max_masks = 3;
			payload.include_scores = true;
		}

		const response = await fetch(params.endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Key ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});

		const body = await response.text();
		if (!body) {
			throw new SegmentError(`${params.model} returned empty body (${response.status})`, response.status);
		}
		let json: FalSegmentResponse | null = null;
		try {
			json = JSON.parse(body) as FalSegmentResponse;
		} catch {
			json = null;
		}

		if (!response.ok) {
			throw new SegmentError(
				`${params.model} failed (${response.status}): ${summarizeFalError(body, json)}`,
				response.status
			);
		}

		const resultImageUrl = extractFalImageUrl(json);
		if (!resultImageUrl) return null;

		const pngBuffer = await fetchImageAsArrayBuffer(resultImageUrl);
		return new Uint8Array(pngBuffer);
	}
}
