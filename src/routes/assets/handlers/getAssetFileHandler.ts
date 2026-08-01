import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { AuthRequest } from 'types';

/**
 * Authenticated proxy: stream an R2 object by key.
 * Avoids embedding expiring R2 presigned URLs in the client.
 *
 * GET /assets/file?key=<r2-object-key>
 */
const getAssetFileHandler: RequestHandler<AuthRequest> = async (request) => {
	const url = new URL(request.url);
	const key = url.searchParams.get('key');

	if (!key || !key.trim()) {
		return error(400, '`key` query param is required');
	}

	// Basic path traversal / absolute-key guard
	if (key.includes('..') || key.startsWith('/')) {
		return error(400, 'Invalid key');
	}

	try {
		const object = await env.OUTFIT_PHOTOS_BUCKET.get(key);
		if (!object) {
			return error(404, 'Asset not found');
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		// Private: tied to the caller's auth; browser/app may cache per URL.
		headers.set('Cache-Control', 'private, max-age=86400');
		headers.set('X-Content-Type-Options', 'nosniff');

		return new Response(object.body, { headers });
	} catch (err) {
		console.error('asset_file_proxy_failed', key, err);
		return error(500, 'Failed to fetch asset');
	}
};

export default getAssetFileHandler;
