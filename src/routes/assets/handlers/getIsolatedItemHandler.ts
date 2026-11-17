import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { ApiRequest } from 'types';
import { CATALOG_BOX_PAD, closetTilePad, percentBoxToTrim } from 'utils/bounding_box';
import { getImageDimensions } from 'utils/image.utils';
import { orientImageJpeg } from 'utils/cf_images.utils';
import { parseIsolateCutout, parseIsolatePad, parseIsolateWidth } from 'utils/assets.utils';
import { getR2ObjectBytes, r2BytesResponse } from 'utils/r2.utils';
import {
	isolateDerivedKey,
	isolateOrientedKey,
	isSafeR2Key,
	type IsolateCacheParams,
} from 'utils/isolate_cache';

export type IsolateServeDeps = {
	bucket: R2Bucket;
	images: ImagesBinding;
	waitUntil?: (promise: Promise<unknown>) => void;
};

const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Crop a clothing item. Percent boxes are applied to the EXIF-oriented pixels,
 * not to caller-supplied imgW/imgH (those were often dummy 1000×1000).
 *
 * Default: padded crop + `segment: foreground` (PNG) with catalog pad.
 * `cutout=0`: closet photo crop (JPEG) with category-aware pad. `category` selects the pad.
 * `pad=0`: trim the exact percent box (item-view native-aspect crop).
 * Optional `width` scales the crop down (fit: scale-down) before the rest of the pipeline.
 *
 * Write-through: first miss runs the live transform and stores the derived object
 * (and an oriented original) in R2. Repeat GETs return the derived bytes with Content-Length.
 */
export async function serveIsolatedItem(request: ApiRequest, deps: IsolateServeDeps): Promise<Response> {
	try {
		const { query } = request;

		if (typeof query.key !== 'string') {
			return error(400, '`key` query param is required');
		}
		if (!isSafeR2Key(query.key)) {
			return error(400, 'Invalid key');
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

		const width = parseIsolateWidth(query.width);
		if (width === null) {
			return error(400, '`width` must be a positive integer');
		}
		const cutout = parseIsolateCutout(query.cutout);
		const applyPad = parseIsolatePad(query.pad);
		const category = typeof query.category === 'string' ? query.category.trim() : '';
		const pad = !applyPad ? undefined : cutout ? CATALOG_BOX_PAD : closetTilePad(category || undefined);

		const cacheParams: IsolateCacheParams = {
			key: query.key,
			x,
			y,
			w,
			h,
			width,
			cutout,
			pad: applyPad,
			category,
		};
		const derivedKey = await isolateDerivedKey(cacheParams);
		const orientedKey = isolateOrientedKey(query.key);
		if (!orientedKey) {
			return error(400, 'Invalid key');
		}

		const derivedHit = await getR2ObjectBytes(deps.bucket, derivedKey);
		if (derivedHit) {
			const headers = new Headers();
			derivedHit.writeHttpMetadata(headers);
			if (!headers.has('content-type')) {
				headers.set('Content-Type', cutout ? 'image/png' : 'image/jpeg');
			}
			headers.set('Cache-Control', CACHE_CONTROL_IMMUTABLE);
			return r2BytesResponse(derivedHit.bytes, headers);
		}

		const { orientedBytes, putOriented } = await loadOrientedOriginal(
			deps,
			query.key,
			orientedKey,
		);
		if (!orientedBytes) {
			return error(404, 'Outfit image not found in storage');
		}

		const { width: imgW, height: imgH } = await getImageDimensions(orientedBytes);
		const trim = percentBoxToTrim({ x, y, width: w, height: h }, imgW, imgH, pad);

		let pipeline = deps.images.input(new Blob([orientedBytes]).stream()).transform({ trim });
		if (width != null) {
			pipeline = pipeline.transform({ width, fit: 'scale-down' });
		}
		if (cutout) {
			pipeline = pipeline.transform({
				segment: 'foreground',
				sharpen: 1.5,
				contrast: 0.05,
			});
		}

		const transformedImage = (
			await pipeline.output({
				format: cutout ? 'image/png' : 'image/jpeg',
				quality: 85,
			})
		).response();

		const derivedBytes = await transformedImage.arrayBuffer();
		const contentType =
			transformedImage.headers.get('content-type') || (cutout ? 'image/png' : 'image/jpeg');

		const puts: Promise<unknown>[] = [
			deps.bucket.put(derivedKey, derivedBytes, {
				httpMetadata: { contentType },
			}),
		];
		if (putOriented) {
			puts.push(
				deps.bucket.put(orientedKey, orientedBytes, {
					httpMetadata: { contentType: 'image/jpeg' },
				}),
			);
		}
		await schedulePuts(deps.waitUntil, Promise.all(puts));

		const missHeaders = new Headers({
			'Content-Type': contentType,
			'Cache-Control': CACHE_CONTROL_IMMUTABLE,
		});
		return r2BytesResponse(derivedBytes, missHeaders);
	} catch (err) {
		request.log.error('isolate_outfit_item_failed', {}, err);
		return error(500, 'Internal Server Error');
	}
}

async function loadOrientedOriginal(
	deps: IsolateServeDeps,
	sourceKey: string,
	orientedKey: string,
): Promise<{ orientedBytes: ArrayBuffer | null; putOriented: boolean }> {
	const cached = await getR2ObjectBytes(deps.bucket, orientedKey);
	if (cached) {
		return { orientedBytes: cached.bytes, putOriented: false };
	}

	const source = await getR2ObjectBytes(deps.bucket, sourceKey);
	if (!source) {
		return { orientedBytes: null, putOriented: false };
	}

	const orientedBytes = await orientImageJpeg(deps.images, source.bytes);
	return { orientedBytes, putOriented: true };
}

async function schedulePuts(waitUntil: IsolateServeDeps['waitUntil'], puts: Promise<unknown>): Promise<void> {
	if (waitUntil) {
		waitUntil(puts);
		return;
	}
	await puts;
}

const getIsolatedItemHandler: RequestHandler<ApiRequest> = (request) =>
	serveIsolatedItem(request, {
		bucket: env.OUTFIT_PHOTOS_BUCKET,
		images: env.IMAGES,
		waitUntil: request.ctx ? (promise) => request.ctx!.waitUntil(promise) : undefined,
	});

export default getIsolatedItemHandler;
