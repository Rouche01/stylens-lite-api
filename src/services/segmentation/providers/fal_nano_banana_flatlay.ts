import { fetchImageAsArrayBuffer } from '../../../utils/assets.utils';
import { SegmentError } from './base.provider';

const FAL_NANO_BANANA_EDIT = 'https://fal.run/fal-ai/nano-banana/edit';

type FalImageFile = {
	url?: string;
	content_type?: string;
	file_data?: string;
	data?: string;
	data_uri?: string;
};

type FalNanoBananaEditResponse = {
	images?: Array<FalImageFile | string> | null;
	image?: FalImageFile | string | null;
	description?: string;
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

function extractImageUrl(json: FalNanoBananaEditResponse | null): string | undefined {
	if (!json) return undefined;
	if (Array.isArray(json.images)) {
		for (const item of json.images) {
			const url = falFileToUrl(item);
			if (url) return url;
		}
	}
	return falFileToUrl(json.image);
}

function summarizeFalError(body: string, json: FalNanoBananaEditResponse | null): string {
	if (json?.detail != null) {
		return typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail).slice(0, 500);
	}
	if (json?.error != null) {
		return typeof json.error === 'string' ? json.error : JSON.stringify(json.error).slice(0, 500);
	}
	return body.slice(0, 500);
}

/** Catalog flat-lay / ghost-mannequin style prompt for a named worn garment. */
export function flatlayPromptForLabel(label: string): string {
	const piece = label.trim() || 'garment';
	return [
		`Create a clean e-commerce catalog flat-lay product photo of only this ${piece}.`,
		'Preserve the exact colors, pattern, print, fabric texture, and distinctive details from the reference.',
		'No person, no mannequin, no hands, no phone, no room background.',
		'Lay the garment neatly on a soft mint or light neutral surface, soft even studio lighting, slight natural shadow.',
		'Square product shot, single garment filling most of the frame.',
	].join(' ');
}

/**
 * Generative try-off / packshot via Fal Nano Banana edit (Gemini Flash Image).
 * Spike helper for admin face preview — not a product pipeline.
 */
export async function falNanoBananaFlatlay(params: {
	apiKey: string;
	imageUrl: string;
	label: string;
}): Promise<{ pngBytes: Uint8Array; model: string }> {
	const { apiKey, imageUrl, label } = params;
	if (!apiKey) {
		throw new SegmentError('FAL_KEY is not set');
	}
	if (!imageUrl) {
		throw new SegmentError('imageUrl is required for flat-lay');
	}

	const model = 'fal-ai/nano-banana/edit';
	const response = await fetch(FAL_NANO_BANANA_EDIT, {
		method: 'POST',
		headers: {
			Authorization: `Key ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			prompt: flatlayPromptForLabel(label),
			image_urls: [imageUrl],
			num_images: 1,
			aspect_ratio: '1:1',
			output_format: 'png',
		}),
	});

	const body = await response.text();
	if (!body) {
		throw new SegmentError(`${model} returned empty body (${response.status})`, response.status);
	}

	let json: FalNanoBananaEditResponse | null = null;
	try {
		json = JSON.parse(body) as FalNanoBananaEditResponse;
	} catch {
		json = null;
	}

	if (!response.ok) {
		throw new SegmentError(`${model} failed (${response.status}): ${summarizeFalError(body, json)}`, response.status);
	}

	const resultUrl = extractImageUrl(json);
	if (!resultUrl) {
		throw new SegmentError(`${model} returned no image`, 422);
	}

	const buffer = await fetchImageAsArrayBuffer(resultUrl);
	return { pngBytes: new Uint8Array(buffer), model };
}
