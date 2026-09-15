import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { getIsolatedItemUrl, signClosetOriginalUrl, CLOSET_TILE_ISOLATE_WIDTH } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';

const getClosetItemsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const userId = request.user.dbId;

		const items = await closetDB.getClosetItems(userId);

		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		const enrichedItems = await Promise.all(
			items.map(async (item) => {
				const originalImageUrl = await signClosetOriginalUrl(item.image_key, item.original_image_url);
				if (!originalImageUrl || !item.bounding_box) {
					return { ...item, original_image_url: originalImageUrl };
				}

				return {
					...item,
					original_image_url: originalImageUrl,
					isolated_image_url: getIsolatedItemUrl({
						domain,
						imageUrl: originalImageUrl,
						imageKey: item.image_key,
						boundingBox: item.bounding_box,
						width: CLOSET_TILE_ISOLATE_WIDTH,
						cutout: false,
						category: item.category,
						enhance,
					}),
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
