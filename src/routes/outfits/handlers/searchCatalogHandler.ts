import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { CatalogSearchError, createCatalogService } from 'services/catalog';
import { signDownloadUrlForKey } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';
import { ApiRequest } from 'types';

/**
 * TEMP admin test hook: find a catalog stand-in for one extract item (no D1).
 *
 * POST /outfits/catalog/search
 * Header: x-admin-api-key
 * Body: { imageKey, boundingBox, color?, subcategory?, pattern?, label? }
 * Identity stays on the worn photo. This JPEG is presentation / later FASHN input.
 */
type CatalogSearchBody = {
	imageKey?: string;
	label?: string;
	color?: string;
	subcategory?: string;
	pattern?: string;
	boundingBox?: {
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
};

function parsePercentBox(box: CatalogSearchBody['boundingBox']) {
	if (box == null) return undefined;
	if (
		typeof box.x !== 'number' ||
		typeof box.y !== 'number' ||
		typeof box.width !== 'number' ||
		typeof box.height !== 'number'
	) {
		return undefined;
	}
	return { x: box.x, y: box.y, width: box.width, height: box.height };
}

const searchCatalogHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as CatalogSearchBody;
		const imageKey = body.imageKey?.trim();
		const boundingBox = parsePercentBox(body.boundingBox);

		if (!imageKey) {
			return error(400, 'imageKey is required');
		}
		if (!boundingBox) {
			return error(400, 'boundingBox must include numeric x, y, width, height (percents 0-100)');
		}

		const catalogService = createCatalogService(env, request.log);
		const result = await catalogService.searchFromR2({
			imageKey,
			boundingBox,
			color: body.color?.trim(),
			subcategory: body.subcategory?.trim(),
			pattern: body.pattern?.trim(),
			label: body.label?.trim(),
		});

		const scratchKey = `catalog/scratch/${crypto.randomUUID()}.jpg`;
		await env.OUTFIT_PHOTOS_BUCKET.put(scratchKey, result.pngBytes, {
			httpMetadata: { contentType: result.contentType },
		});
		const imageUrl = await signDownloadUrlForKey(scratchKey);

		return new Response(
			JSON.stringify({
				message: 'Catalog stand-in found',
				image_key: scratchKey,
				image_url: imageUrl,
				crop_image_key: result.cropImageKey,
				source_image_key: result.imageKey,
				query_used: result.queryUsed,
				provider: result.provider,
				engine: result.engine,
				source_title: result.sourceTitle,
				source: result.source,
			}),
			{
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (err) {
		logRouteError(request.log, 'admin_catalog_search_failed', err);
		if (err instanceof SyntaxError) {
			return error(400, 'Request body must be JSON: { imageKey, boundingBox, color?, subcategory? }');
		}
		if (err instanceof CatalogSearchError) {
			if (err.status === 403) return error(403, err.message);
			if (err.status === 404) return error(404, err.message);
			if (err.status === 422) return error(422, err.message);
			if (err.status === 500) return error(500, err.message);
			const status = err.isRetryable ? 502 : 400;
			return error(status, err.message);
		}
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default searchCatalogHandler;
