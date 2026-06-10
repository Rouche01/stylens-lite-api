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

		console.log("isolate: x: ", x);
		console.log("isolate: y: ", y);
		console.log("isolate: w: ", w);
		console.log("isolate: h: ", h);
		console.log("isolate: imgW: ", imgW);
		console.log("isolate: imgH: ", imgH);

		if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h) || isNaN(imgW) || isNaN(imgH)) {
			return error(400, 'Invalid numeric parameters');
		}



		// 1. Calculate padded bounding box to prevent clipping sleeves/hems/collars
		// We add a comfortable padding (10% of the crop dimension, clamped between 1% and 5% of visual image size)
		const padW = Math.max(1, Math.min(5, w * 0.10));
		const padH = Math.max(1, Math.min(5, h * 0.10));

		const paddedX = Math.max(0, x - padW);
		const paddedY = Math.max(0, y - padH);
		const paddedW = Math.min(100 - paddedX, w + padW * 2);
		const paddedH = Math.min(100 - paddedY, h + padH * 2);

		// 2. Calculate the trim values based on the padded bounding box (pixels to trim from each side)
		const top = Math.round((paddedY / 100) * imgH);
		const left = Math.round((paddedX / 100) * imgW);
		const bottom = Math.max(0, Math.round(imgH - ((paddedY + paddedH) / 100) * imgH));
		const right = Math.max(0, Math.round(imgW - ((paddedX + paddedW) / 100) * imgW));

		// 3. Fetch the raw image internally from the private R2 bucket binding
		const r2Object = await env.OUTFIT_PHOTOS_BUCKET.get(query.key);
		if (!r2Object) {
			return error(404, 'Outfit image not found in storage');
		}

		// 4. Auto-orient the image first to align pixel orientation with EXIF headers
		const orientedImage = (await env.IMAGES.input(r2Object.body)
			.output({
				format: 'image/png',
				quality: 90,
			})).response();

		if (!orientedImage.body) {
			return error(500, 'Failed to orient outfit image');
		}

		// 5. Perform in-memory transformation using Cloudflare's native IMAGES binding on the auto-oriented image
		// We chain the transforms: first trim/crop the image, then remove the background and apply professional enhancement.
		// Native sharpening (1.5) and a slight contrast boost (0.05) deliver crisp, studio-grade luxury catalog quality without latency or hallucinations.
		const transformedImage = (await env.IMAGES.input(orientedImage.body)
			.transform({
				trim: {
					top: top,
					left: left,
					bottom: bottom,
					right: right
				}
			})
			.transform({
				segment: 'foreground',
				sharpen: 1.5,
				contrast: 0.05
			})
			.output({
				format: 'image/png',
				quality: 85
			})).response();

		// 6. Wrap response with strong caching headers to cache this exact isolated item at the Edge
		const response = new Response(transformedImage.body, transformedImage);
		response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		return response;

	} catch (err) {
		console.error('Failed to isolate outfit item:', err);
		return error(500, 'Internal Server Error');
	}
};

export default getIsolatedItemHandler;
