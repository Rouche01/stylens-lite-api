import { fetchImageAsArrayBuffer } from '../../../utils/assets.utils';
import { SegmentError } from './base.provider';

const FAL_BIREFNET_V2 = 'https://fal.run/fal-ai/birefnet/v2';

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

function summarizeFalError(body: string, json: FalBirefnetResponse | null): string {
	if (json?.detail != null) {
		return typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail).slice(0, 500);
	}
	if (json?.error != null) {
		return typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 500);
	}
	return body.slice(0, 500);
}

/**
 * Soft-matte a cutout / subject PNG via Fal BiRefNet v2.
 * Spike helper — not part of SegmentProvider.
 */
export async function falBirefnetMatte(params: {
	apiKey: string;
	imageUrl: string;
}): Promise<Uint8Array> {
	const { apiKey, imageUrl } = params;
	if (!apiKey) {
		throw new SegmentError('FAL_KEY is not set');
	}
	if (!imageUrl) {
		throw new SegmentError('imageUrl is required for BiRefNet');
	}

	const response = await fetch(FAL_BIREFNET_V2, {
		method: 'POST',
		headers: {
			Authorization: `Key ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			image_url: imageUrl,
			model: 'Matting',
			operating_resolution: '1024x1024',
			refine_foreground: true,
			output_format: 'png',
		}),
	});

	const body = await response.text();
	if (!body) {
		throw new SegmentError(`fal-ai/birefnet/v2 returned empty body (${response.status})`, response.status);
	}

	let json: FalBirefnetResponse | null = null;
	try {
		json = JSON.parse(body) as FalBirefnetResponse;
	} catch {
		json = null;
	}

	if (!response.ok) {
		throw new SegmentError(
			`fal-ai/birefnet/v2 failed (${response.status}): ${summarizeFalError(body, json)}`,
			response.status
		);
	}

	const resultUrl = falFileToUrl(json?.image) ?? falFileToUrl(json?.mask_image);
	if (!resultUrl) {
		throw new SegmentError('fal-ai/birefnet/v2 returned no image', 422);
	}

	const buffer = await fetchImageAsArrayBuffer(resultUrl);
	return new Uint8Array(buffer);
}
