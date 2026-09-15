import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

const client = new AwsClient({
	accessKeyId: env.OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID,
	secretAccessKey: env.OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY,
});

const bucketName = env.OUTFIT_PHOTOS_BUCKET_NAME;
const accountId = env.R2_ACCOUNT_ID;

/** Presigned GET lifetime in seconds (matches upload/download-url handlers). */
export const PRESIGNED_GET_EXPIRES_SECONDS = 3600;

/** Sign a fresh download URL for an R2 object key. */
export async function signDownloadUrlForKey(key: string): Promise<string> {
	const downloadUrl = new URL(`https://${bucketName}.${accountId}.r2.cloudflarestorage.com`);
	downloadUrl.pathname = `/${key}`;
	downloadUrl.searchParams.set('X-Amz-Expires', String(PRESIGNED_GET_EXPIRES_SECONDS));

	const presigned = await client.sign(new Request(downloadUrl, { method: 'GET' }), {
		aws: { signQuery: true },
	});
	return presigned.url;
}

/** Fresh GET for a closet/outfit photo. Prefer the stored R2 key over a URL signed at extract time. */
export async function signClosetOriginalUrl(imageKey?: string, fallbackUrl?: string): Promise<string | undefined> {
	if (imageKey) return signDownloadUrlForKey(imageKey);
	if (fallbackUrl) return regenerateSignedUrl(fallbackUrl);
	return undefined;
}

export const regenerateSignedUrl = async (imageUrl: string): Promise<string> => {
	// Check if it's an R2 URL that needs re-signing
	if (!imageUrl.includes('r2.cloudflarestorage.com')) {
		return imageUrl; // Not an R2 URL, return as is
	}

	try {
		// Extract filename from the existing URL
		const url = new URL(imageUrl);
		const filename = url.pathname.slice(1); // Remove leading '/'

		return await signDownloadUrlForKey(filename);
	} catch (error) {
		console.error('Error regenerating signed URL:', error);
		return imageUrl; // Fallback to original URL
	}
};

export function arrayBufferToBase64(buffer: ArrayBufferLike): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk as any);
	}
	return btoa(binary);
}

export const fetchImageAsArrayBuffer = async (imageUrl: string): Promise<ArrayBuffer> => {
	if (imageUrl.startsWith('data:')) {
		const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
		if (match) {
			const binaryStr = atob(match[2]);
			const len = binaryStr.length;
			const bytes = new Uint8Array(len);
			for (let i = 0; i < len; i++) {
				bytes[i] = binaryStr.charCodeAt(i);
			}
			return bytes.buffer;
		}
		throw new Error('Invalid data URL format');
	}

	const freshImageUrl = await regenerateSignedUrl(imageUrl);
	const response = await fetch(freshImageUrl);
	if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
	return response.arrayBuffer();
};

export const fetchImageAsBase64 = async (imageUrl: string): Promise<{ base64: string; mediaType: string }> => {
	if (imageUrl.startsWith('data:')) {
		const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
		if (match) {
			return {
				mediaType: match[1],
				base64: match[2],
			};
		}
		throw new Error('Invalid data URL format');
	}

	const freshImageUrl = await regenerateSignedUrl(imageUrl);
	const response = await fetch(freshImageUrl);
	if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

	const arrayBuffer = await response.arrayBuffer();
	const base64 = arrayBufferToBase64(arrayBuffer);
	const mediaType = response.headers.get('content-type') || 'image/jpeg';

	return { base64, mediaType };
};

export const getIsolatedItemUrl = (params: {
	domain: string;
	imageUrl: string;
	imageKey?: string;
	boundingBox: { x: number; y: number; width: number; height: number };
	dimensions?: { width: number; height: number };
	width?: number;
	enhance?: boolean;
	color?: string;
	subcategory?: string;
}): string => {
	const { domain, imageUrl, imageKey, boundingBox, dimensions, width, enhance, color, subcategory } = params;

	// Prefer the stored R2 key so Isolate does not depend on a live signed URL.
	let objectKey = imageKey || imageUrl;
	try {
		if (!imageKey && imageUrl.startsWith('http')) {
			const url = new URL(imageUrl);
			// R2 storage paths are stored in the URL pathname (minus the leading slash)
			objectKey = url.pathname.slice(1);
		}
	} catch (e) {
		// Fallback to imageUrl as key if not a valid URL
	}

	const base = domain.startsWith('http') ? domain : `https://${domain}`;

	// Build a secure local worker image isolation proxy URL
	const searchParams = new URLSearchParams({
		key: objectKey,
		x: boundingBox.x.toString(),
		y: boundingBox.y.toString(),
		w: boundingBox.width.toString(),
		h: boundingBox.height.toString(),
	});

	if (dimensions) {
		searchParams.set('imgW', dimensions.width.toString());
		searchParams.set('imgH', dimensions.height.toString());
	}
	if (width != null) searchParams.set('width', String(width));
	if (enhance) searchParams.append('enhance', 'true');
	if (color) searchParams.append('color', color);
	if (subcategory) searchParams.append('subcategory', subcategory);

	return `${base}/assets/isolate?${searchParams.toString()}`;
};

/** Closet browse tiles: ~3-col phone width with a little headroom for 3x screens. */
export const CLOSET_TILE_ISOLATE_WIDTH = 480;

export const ISOLATE_WIDTH_MIN = 32;
export const ISOLATE_WIDTH_MAX = 2048;

/** Optional isolate `width` query. Undefined when omitted; null when present but invalid. */
export function parseIsolateWidth(raw: unknown): number | undefined | null {
	if (raw == null || raw === '') return undefined;
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	const n = typeof raw === 'number' ? raw : Number(raw.trim());
	if (!Number.isFinite(n) || n < 1) return null;
	return Math.min(ISOLATE_WIDTH_MAX, Math.max(ISOLATE_WIDTH_MIN, Math.round(n)));
}


