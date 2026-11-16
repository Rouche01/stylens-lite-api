import { fetchImageAsArrayBuffer } from '../../../utils/assets.utils';
import { resolvePackshotStudioBackground } from '../../../utils/packshot_background';
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

export type FlatlayPromptOptions = {
	label: string;
	/** Extract color string — hint only; reference pixels win on conflict. */
	color?: string | null;
	category?: string | null;
	subcategory?: string | null;
};

function asMediaUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined;
	if (value.startsWith('http') || value.startsWith('data:image')) return value;
	return undefined;
}

function falFileToUrl(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value !== 'string') {
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
	return asMediaUrl(value);
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

function normalizeCategory(category?: string | null): string {
	return (category || '').trim().toLowerCase();
}

function categoryGuidance(category?: string | null, subcategory?: string | null): string[] {
	const cat = normalizeCategory(category);
	const sub = (subcategory || '').trim().toLowerCase();
	const kind = sub || cat || 'garment';

	if (cat === 'footwear') {
		return [
			`This is footwear (${kind}). Preserve the exact shoe type, height, toe shape, sole, and closures from the reference.`,
			'Keep lace-ups as lace-ups, sneakers as sneakers, boots as boots — do not invent a different style (no Chelsea boot unless the reference is one).',
			'Show a clean product view of the same shoe(s) as in the reference; do not swap in a generic catalog boot.',
		];
	}

	if (cat === 'accessory') {
		return [
			`This is an accessory (${kind}). Preserve the exact silhouette, brim/strap/hardware, and any logo or embroidery from the reference.`,
			'Match the visible fabric color in the reference image — never repaint the item to match a color word in the name.',
		];
	}

	return [];
}

/**
 * Catalog flat-lay / ghost-mannequin prompt.
 * Reference image is authoritative for color and construction; label is type only.
 */
export function flatlayPromptForGarment(options: FlatlayPromptOptions): string {
	const piece = options.label.trim() || 'garment';
	const colorHint = options.color?.trim();
	const parts = [
		`Create a clean e-commerce catalog flat-lay product photo of only this ${piece}.`,
		'The reference image is the source of truth for appearance: preserve the exact colors, pattern, print, fabric texture, logos, and distinctive details as seen in the image.',
		'The garment name is only a type hint. If any word in the name (including a color word) conflicts with what you see, follow the reference image — never recolor to match the name.',
	];
	if (colorHint) {
		parts.push(
			`Extract color hint "${colorHint}" — use it only when it agrees with the reference; otherwise prefer the pixels.`
		);
	}
	parts.push(...categoryGuidance(options.category, options.subcategory));
	const studioBg = resolvePackshotStudioBackground({ color: options.color });
	parts.push(
		'No person, no mannequin, no hands, no phone, no room background.',
		studioBg.promptClause,
		'Square product shot, single garment filling most of the frame.'
	);
	return parts.join(' ');
}

/** @deprecated Prefer flatlayPromptForGarment — kept for call sites that only have a label. */
export function flatlayPromptForLabel(label: string): string {
	return flatlayPromptForGarment({ label });
}

/**
 * Generative try-off / packshot via Fal Nano Banana edit (Gemini Flash Image).
 */
export async function falNanoBananaFlatlay(params: {
	apiKey: string;
	imageUrl: string;
	label: string;
	color?: string | null;
	category?: string | null;
	subcategory?: string | null;
}): Promise<{ pngBytes: Uint8Array; model: string }> {
	const { apiKey, imageUrl, label, color, category, subcategory } = params;
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
			prompt: flatlayPromptForGarment({ label, color, category, subcategory }),
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
