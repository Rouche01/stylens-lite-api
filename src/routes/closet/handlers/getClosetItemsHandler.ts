import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { getIsolatedItemUrl } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';

const getClosetItemsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const userId = request.user.dbId;

		const items = await closetDB.getClosetItems(userId);

		// Get current worker host domain dynamically from the request URL
		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		// Enrich each closet item with its secure transparent isolated crop URL
		const enrichedItems = items.map(item => {
			if (item.original_image_url && item.bounding_box) {
				return {
					...item,
					isolated_image_url: getIsolatedItemUrl({
						domain,
						imageUrl: item.original_image_url,
						boundingBox: item.bounding_box,
						dimensions: { width: 1000, height: 1000 }, // Or default bounds since coordinates are percentage-based
						enhance,
						color: item.color,
						subcategory: item.subcategory
					})
				};
			}
			return item;
		});

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
