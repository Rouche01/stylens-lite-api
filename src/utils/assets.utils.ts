import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

const client = new AwsClient({
	accessKeyId: env.OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID,
	secretAccessKey: env.OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY,
});

const bucketName = env.OUTFIT_PHOTOS_BUCKET_NAME;
const accountId = env.R2_ACCOUNT_ID;

export const regenerateSignedUrl = async (imageUrl: string): Promise<string> => {
	// Check if it's an R2 URL that needs re-signing
	if (!imageUrl.includes('r2.cloudflarestorage.com')) {
		return imageUrl; // Not an R2 URL, return as is
	}

	try {
		// Extract filename from the existing URL
		const url = new URL(imageUrl);
		const filename = url.pathname.slice(1); // Remove leading '/'

		// Generate fresh download URL
		const downloadUrl = new URL(`https://${bucketName}.${accountId}.r2.cloudflarestorage.com`);
		downloadUrl.pathname = `/${filename}`;
		downloadUrl.searchParams.set('X-Amz-Expires', '3600');

		const presignedDownload = await client.sign(new Request(downloadUrl, { method: 'GET' }), { aws: { signQuery: true } });

		return presignedDownload.url; // Return the signed URL
	} catch (error) {
		console.error('Error regenerating signed URL:', error);
		return imageUrl; // Fallback to original URL
	}
};

export const fetchImageAsBase64 = async (imageUrl: string): Promise<{ base64: string; mediaType: string }> => {
	const response = await fetch(imageUrl);
	if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

	const arrayBuffer = await response.arrayBuffer();
	let binary = '';
	const bytes = new Uint8Array(arrayBuffer);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	const mediaType = response.headers.get('content-type') || 'image/jpeg';

	return { base64, mediaType };
};
