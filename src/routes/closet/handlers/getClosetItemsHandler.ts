import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import {
	getIsolatedItemUrl,
	signClosetOriginalUrl,
	signDownloadUrlForKey,
	CLOSET_TILE_ISOLATE_WIDTH,
	parseIsolateCutout,
} from 'utils/assets.utils';
import { isClosetBrowseItem } from 'utils/closet_browse';
import { closetFaceImageKey, isClosetPackshotReady, resolveClosetFaceSource } from 'utils/closet_face';
import { logRouteError } from 'utils/error';

const getClosetItemsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const userId = request.user.dbId;

		const requirePackshot =
			String(env.GARMENT_FACE_PACKSHOT_ENABLED || '').toLowerCase() === 'true';
		let items = (await closetDB.getClosetItems(userId)).filter(isClosetBrowseItem);
		// Packshot-only grid: omit tiles until a trusted flatlay exists (footwear may never qualify).
		if (requirePackshot) {
			items = items.filter(isClosetPackshotReady);
		}

		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;
		const enhance = requestUrl.searchParams.get('enhance') === 'true';
		// Default: padded photo crop (readable fabric/color). Opt in to CF cutouts with `?cutout=1`
		// once segment quality is good enough for the grid.
		const cutoutParam = requestUrl.searchParams.get('cutout');
		const cutout = cutoutParam == null || cutoutParam === '' ? false : parseIsolateCutout(cutoutParam);

		const enrichedItems = await Promise.all(
			items.map(async (item) => {
				const originalImageUrl = await signClosetOriginalUrl(item.image_key, item.original_image_url);
				if (!originalImageUrl || !item.bounding_box) {
					return { ...item, original_image_url: originalImageUrl };
				}

				const faceSource = resolveClosetFaceSource(item);
				const faceKey = closetFaceImageKey(item);
				const faceUrl = faceKey ? await signDownloadUrlForKey(faceKey) : null;
				const cropIsolateUrl = getIsolatedItemUrl({
					domain,
					imageUrl: originalImageUrl,
					imageKey: item.image_key,
					boundingBox: item.bounding_box,
					width: CLOSET_TILE_ISOLATE_WIDTH,
					cutout,
					category: item.category,
					enhance,
				});

				return {
					...item,
					original_image_url: originalImageUrl,
					face_source: faceSource,
					// Hybrid: stored flatlay/cutout when present; else padded crop isolate.
					isolated_image_url: faceUrl || cropIsolateUrl,
					crop_image_url: cropIsolateUrl,
				};
			})
		);

		return new Response(JSON.stringify({ items: enrichedItems }), {
			headers: { 'Content-Type': 'application/json' },
			status: 200
		});

	} catch (err) {
		logRouteError(request.log, 'get_closet_items_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default getClosetItemsHandler;
