import { arrayBufferToBase64, fetchImageAsArrayBuffer, signDownloadUrlForKey } from '../../utils/assets.utils';
import { Logger, createLogger } from '../../utils/logger.utils';

const FAL_FASHN_ENDPOINT = 'https://fal.run/fal-ai/fashn/tryon/v1.6';
export const TRYON_MODEL = 'fal-ai/fashn/tryon/v1.6';

export const CLOTH_TYPES = ['upper', 'lower', 'overall', 'inner', 'outer'] as const;
export type ClothType = (typeof CLOTH_TYPES)[number];

export type FashnCategory = 'tops' | 'bottoms' | 'one-pieces';

export class TryonError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'TryonError';
	}

	get isRetryable(): boolean {
		return this.status == null || this.status === 429 || this.status >= 500;
	}
}

export function isClothType(value: string): value is ClothType {
	return (CLOTH_TYPES as readonly string[]).includes(value);
}

export function clothTypeToFashnCategory(clothType: ClothType): FashnCategory {
	if (clothType === 'lower') return 'bottoms';
	if (clothType === 'overall') return 'one-pieces';
	return 'tops';
}

type FalFile = { url?: string; file_data?: string; content_type?: string };

function falFileUrl(value: unknown): string | undefined {
	if (typeof value === 'string' && (value.startsWith('http') || value.startsWith('data:image'))) {
		return value;
	}
	if (!value || typeof value !== 'object') return undefined;
	const file = value as FalFile;
	if (typeof file.url === 'string' && file.url.length > 0) return file.url;
	if (typeof file.file_data === 'string' && file.file_data.length > 0) {
		if (file.file_data.startsWith('data:')) return file.file_data;
		return `data:${file.content_type || 'image/png'};base64,${file.file_data}`;
	}
	return undefined;
}

function extractFashnImageUrl(json: { image?: unknown; images?: unknown } | null): string | undefined {
	if (!json) return undefined;
	if (Array.isArray(json.images) && json.images.length > 0) {
		return falFileUrl(json.images[0]);
	}
	return falFileUrl(json.image);
}

export type TryOnFromR2Params = {
	avatarImageKey: string;
	garmentImageKey: string;
	clothType: ClothType;
};

export type TryOnResult = {
	pngBytes: Uint8Array;
	model: string;
	clothType: ClothType;
	category: FashnCategory;
	avatarImageKey: string;
	garmentImageKey: string;
};

/**
 * Stage 4: FASHN try-on. SAM cutouts are worn-item isolates, not CatVTON catalog
 * photos — flatten onto white and send as garment_photo_type=flat-lay so the
 * garment encoder actually sees the cutout.
 */
export class TryonService {
	constructor(
		private apiKey: string,
		private bucket: R2Bucket,
		private images: ImagesBinding,
		private log: Logger
	) {}

	async tryOnFromR2(params: TryOnFromR2Params): Promise<TryOnResult> {
		const { avatarImageKey, garmentImageKey, clothType } = params;
		const category = clothTypeToFashnCategory(clothType);
		const log = this.log.child({
			avatar_image_key: avatarImageKey,
			garment_image_key: garmentImageKey,
			cloth_type: clothType,
			category,
			model: TRYON_MODEL,
		});

		if (!this.apiKey) {
			throw new TryonError('FAL_KEY is not set');
		}

		const [avatarObj, garmentObj] = await Promise.all([
			this.bucket.get(avatarImageKey),
			this.bucket.get(garmentImageKey),
		]);
		if (!avatarObj) throw new TryonError(`Avatar image not found in R2: ${avatarImageKey}`, 404);
		if (!garmentObj) throw new TryonError(`Garment image not found in R2: ${garmentImageKey}`, 404);
		if (!garmentObj.body) throw new TryonError(`Garment object has no body: ${garmentImageKey}`, 422);

		const garmentJpeg = await this.flattenCutoutOnWhite(garmentObj.body);
		const garmentDataUri = `data:image/jpeg;base64,${arrayBufferToBase64(garmentJpeg)}`;
		const modelImageUrl = await signDownloadUrlForKey(avatarImageKey);

		log.info('tryon_start', { garment_bytes: garmentJpeg.byteLength, garment_photo_type: 'flat-lay' });

		const response = await fetch(FAL_FASHN_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Key ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model_image: modelImageUrl,
				garment_image: garmentDataUri,
				category,
				mode: 'balanced',
				garment_photo_type: 'flat-lay',
				moderation_level: 'permissive',
				num_samples: 1,
				segmentation_free: true,
				output_format: 'png',
			}),
		});

		const body = await response.text();
		if (!body) {
			throw new TryonError(`${TRYON_MODEL} returned empty body (${response.status})`, response.status);
		}
		let json: { image?: unknown; images?: unknown; detail?: unknown; error?: unknown } | null = null;
		try {
			json = JSON.parse(body) as { image?: unknown; images?: unknown; detail?: unknown; error?: unknown };
		} catch {
			json = null;
		}

		if (!response.ok) {
			const detail = json?.detail ?? json?.error ?? body.slice(0, 500);
			const message = typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500);
			throw new TryonError(`${TRYON_MODEL} failed (${response.status}): ${message}`, response.status);
		}

		const resultUrl = extractFashnImageUrl(json);
		if (!resultUrl) {
			throw new TryonError(`${TRYON_MODEL} returned no image url`, 422);
		}

		const pngBuffer = await fetchImageAsArrayBuffer(resultUrl);
		log.info('tryon_ok', { bytes: pngBuffer.byteLength });

		return {
			pngBytes: new Uint8Array(pngBuffer),
			model: TRYON_MODEL,
			clothType,
			category,
			avatarImageKey,
			garmentImageKey,
		};
	}

	private async flattenCutoutOnWhite(stream: ReadableStream): Promise<ArrayBuffer> {
		const result = await this.images.input(stream).output({
			format: 'image/jpeg',
			quality: 90,
			background: '#ffffff',
		});
		const response = result.response();
		if (!response.ok) {
			throw new TryonError(`Failed to flatten garment cutout (${response.status})`, 502);
		}
		return response.arrayBuffer();
	}
}

export const createTryonService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'tryon' });
	return new TryonService(
		envBindings.FAL_KEY,
		envBindings.OUTFIT_PHOTOS_BUCKET,
		envBindings.IMAGES,
		logger
	);
};
