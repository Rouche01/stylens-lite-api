import { fetchImageAsArrayBuffer } from '../../../utils/assets.utils';
import type { Logger } from '../../../utils/logger.utils';
import { FalHttpError, falPostJson } from '../../fal';
import { SegmentError } from './base.provider';

const FAL_BIREFNET_V2 = 'https://fal.run/fal-ai/birefnet/v2';
const BIREFNET_MODEL = 'fal-ai/birefnet/v2';

type FalImageFile = {
	url?: string;
	content_type?: string;
	file_data?: string;
	data?: string;
	data_uri?: string;
};

type FalBirefnetResponse = {
	image?: FalImageFile | string | null;
	mask_image?: FalImageFile | string | null;
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
	const obj = value as FalImageFile;
	const direct = asMediaUrl(obj.url) ?? asMediaUrl(obj.data_uri);
	if (direct) return direct;
	const raw = obj.file_data ?? obj.data;
	if (typeof raw === 'string' && raw.length > 0) {
		if (raw.startsWith('data:')) return raw;
		const mime = obj.content_type || 'image/png';
		return `data:${mime};base64,${raw}`;
	}
	return undefined;
}

/**
 * Soft-matte a cutout / subject PNG via Fal BiRefNet v2.
 * Spike helper — not part of SegmentProvider.
 */
export async function falBirefnetMatte(params: {
	apiKey: string;
	imageUrl: string;
	log?: Logger;
	signal?: AbortSignal;
}): Promise<Uint8Array> {
	const { apiKey, imageUrl, log, signal } = params;
	if (!apiKey?.trim()) {
		throw new SegmentError('FAL_KEY is not set');
	}
	if (!imageUrl) {
		throw new SegmentError('imageUrl is required for BiRefNet');
	}

	let json: FalBirefnetResponse;
	try {
		const result = await falPostJson<FalBirefnetResponse>({
			apiKey,
			endpoint: FAL_BIREFNET_V2,
			model: BIREFNET_MODEL,
			useCase: 'matte',
			log,
			signal,
			body: {
				image_url: imageUrl,
				model: 'Matting',
				operating_resolution: '1024x1024',
				refine_foreground: true,
				output_format: 'png',
			},
		});
		json = result.json;
	} catch (err) {
		if (err instanceof FalHttpError) {
			throw new SegmentError(err.message, err.status);
		}
		throw err;
	}

	const resultUrl = falFileToUrl(json.image) ?? falFileToUrl(json.mask_image);
	if (!resultUrl) {
		throw new SegmentError('fal-ai/birefnet/v2 returned no image', 422);
	}

	const buffer = await fetchImageAsArrayBuffer(resultUrl);
	return new Uint8Array(buffer);
}
