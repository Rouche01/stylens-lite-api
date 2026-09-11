import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { ApiRequest } from 'types';
import { getImageDimensions } from 'utils/image.utils';
import { orientImageJpeg } from 'utils/cf_images.utils';

/**
 * Crop + isolate a clothing item. Percent boxes are applied to the EXIF-oriented pixels,
 * not to caller-supplied imgW/imgH (those were often dummy 1000×1000).
 */
const getIsolatedItemHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const { query } = request;

		if (typeof query.key !== 'string') {
			return error(400, '`key` query param is required');
		}
		if (typeof query.x !== 'string' || typeof query.y !== 'string' || typeof query.w !== 'string' || typeof query.h !== 'string') {
			return error(400, 'Bounding box parameters `x`, `y`, `w`, and `h` are required');
		}

		const x = parseFloat(query.x);
		const y = parseFloat(query.y);
		const w = parseFloat(query.w);
		const h = parseFloat(query.h);

		if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) {
			return error(400, 'Invalid numeric parameters');
		}

		const r2Object = await env.OUTFIT_PHOTOS_BUCKET.get(query.key);
		if (!r2Object) {
			return error(404, 'Outfit image not found in storage');
		}

		const orientedBytes = await orientImageJpeg(env.IMAGES, await r2Object.arrayBuffer());
		const { width: imgW, height: imgH } = await getImageDimensions(orientedBytes);

		const padW = Math.max(1, Math.min(5, w * 0.10));
		const padH = Math.max(1, Math.min(5, h * 0.10));
		const paddedX = Math.max(0, x - padW);
		const paddedY = Math.max(0, y - padH);
		const paddedW = Math.min(100 - paddedX, w + padW * 2);
		const paddedH = Math.min(100 - paddedY, h + padH * 2);

		const top = Math.round((paddedY / 100) * imgH);
		const left = Math.round((paddedX / 100) * imgW);
		const bottom = Math.max(0, Math.round(imgH - ((paddedY + paddedH) / 100) * imgH));
		const right = Math.max(0, Math.round(imgW - ((paddedX + paddedW) / 100) * imgW));

		const transformedImage = (
			await env.IMAGES.input(new Blob([orientedBytes]).stream())
				.transform({
					trim: {
						top,
						left,
						bottom,
						right
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
				})
		).response();

		const response = new Response(transformedImage.body, transformedImage);
		response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		return response;

	} catch (err) {
		request.log.error('isolate_outfit_item_failed', {}, err);
		return error(500, 'Internal Server Error');
	}
};

export default getIsolatedItemHandler;
