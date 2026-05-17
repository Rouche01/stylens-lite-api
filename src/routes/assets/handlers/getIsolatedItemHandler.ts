import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';

/**
 * Request handler to securely isolate a clothing item from an outfit image.
 * Uses the private R2 bucket binding and Cloudflare's programmatic Images binding
 * to crop and strip the background entirely in-memory, locked behind worker authorization.
 */
const getIsolatedItemHandler: RequestHandler = async (request) => {
	try {
		const { query } = request;

		if (typeof query.key !== 'string') {
			return error(400, '`key` query param is required');
		}
		if (typeof query.x !== 'string' || typeof query.y !== 'string' || typeof query.w !== 'string' || typeof query.h !== 'string') {
			return error(400, 'Bounding box parameters `x`, `y`, `w`, and `h` are required');
		}
		if (typeof query.imgW !== 'string' || typeof query.imgH !== 'string') {
			return error(400, 'Image dimension parameters `imgW` and `imgH` are required');
		}

		const x = parseFloat(query.x);
		const y = parseFloat(query.y);
		const w = parseFloat(query.w);
		const h = parseFloat(query.h);
		const imgW = parseInt(query.imgW, 10);
		const imgH = parseInt(query.imgH, 10);

		if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h) || isNaN(imgW) || isNaN(imgH)) {
			return error(400, 'Invalid numeric parameters');
		}

		// 1. Calculate absolute pixel dimensions for the crop box
		const pxWidth = Math.round((w / 100) * imgW);
		const pxHeight = Math.round((h / 100) * imgH);

		// 2. Fetch the raw image internally from the private R2 bucket binding
		const r2Object = await env.OUTFIT_PHOTOS_BUCKET.get(query.key);
		if (!r2Object) {
			return error(404, 'Outfit image not found in storage');
		}

		// 3. Calculate gravity relative center (from 0.0 to 1.0)
		const relativeCenterX = (x + w / 2) / 100;
		const relativeCenterY = (y + h / 2) / 100;

		// 4. Perform in-memory transformation using Cloudflare's native IMAGES binding
		const transformedImage = (await env.IMAGES.input(r2Object.body)
			.transform({
				segment: 'foreground',
				width: pxWidth,
				height: pxHeight,
				fit: 'crop',
				gravity: {
					x: relativeCenterX,
					y: relativeCenterY,
					mode: 'box-center'
				}
			})
			.output({
				format: 'image/png',
				quality: 85
			})).response();



		// 5. Wrap response with strong caching headers to cache this exact isolated item at the Edge
		const response = new Response(transformedImage.body, transformedImage);
		response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		return response;

	} catch (err) {
		console.error('Failed to isolate outfit item:', err);
		return error(500, 'Internal Server Error');
	}
};

export default getIsolatedItemHandler;
