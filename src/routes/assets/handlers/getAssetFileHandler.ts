import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { AuthRequest } from 'types';
import { getR2ObjectBytes, r2BytesResponse } from 'utils/r2.utils';

/**
 * Authenticated proxy: return an R2 object by key.
 * Avoids embedding expiring R2 presigned URLs in the client.
 *
 * GET /assets/file?key=<r2-object-key>
 *
 * Body is buffered (not streamed) so wrangler remote R2 + ngrok send a complete
 * Content-Length response instead of a chunked stream that phones often abort.
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
		const object = await getR2ObjectBytes(env.OUTFIT_PHOTOS_BUCKET, key);
		if (!object) {
			return error(404, 'Asset not found');
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		// Private: tied to the caller's auth; browser/app may cache per URL.
		headers.set('Cache-Control', 'private, max-age=86400');
		headers.set('X-Content-Type-Options', 'nosniff');

		return r2BytesResponse(object.bytes, headers);
	} catch (err) {
		request.log.error('asset_file_proxy_failed', { key }, err);
		return error(500, 'Failed to fetch asset');
	}
};

export default getAssetFileHandler;
