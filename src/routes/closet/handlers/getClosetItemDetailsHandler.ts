import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { getIsolatedItemUrl } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';

const getClosetItemDetailsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const userId = request.user.dbId;
		const itemId = request.params.id;

		if (!itemId) {
			return error(400, 'Closet item ID is required');
		}

		const details = await closetDB.getClosetItemDetails(userId, itemId);
		if (!details) {
			return error(404, 'Closet item not found');
		}

		// Get current worker host domain dynamically from the request URL
		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		// Enrich primary item crop
		let isolatedImageUrl: string | undefined;
		if (details.original_image_url && details.bounding_box) {
			isolatedImageUrl = getIsolatedItemUrl({
				domain,
				imageUrl: details.original_image_url,
				boundingBox: details.bounding_box,
				dimensions: { width: 1000, height: 1000 },
				enhance,
				color: details.color,
				subcategory: details.subcategory
			});
		}

		// Enrich each wearing event in its history list
		const enrichedHistory = details.wear_history.map(event => ({
			...event,
			isolated_image_url: getIsolatedItemUrl({
				domain,
				imageUrl: event.original_image_url,
				boundingBox: event.bounding_box,
				dimensions: { width: 1000, height: 1000 }
			})
		}));

		const enrichedDetails = {
			...details,
			isolated_image_url: isolatedImageUrl,
			wear_history: enrichedHistory
		};

		return new Response(JSON.stringify(enrichedDetails), {
			headers: { 'Content-Type': 'application/json' },
			status: 200
		});

	} catch (err) {
		logRouteError(request.log, 'get_closet_item_details_failed', err, { item_id: request.params.id });
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default getClosetItemDetailsHandler;
