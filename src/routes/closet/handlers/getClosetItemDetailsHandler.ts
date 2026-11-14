import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { getIsolatedItemUrl, signClosetOriginalUrl, signDownloadUrlForKey } from 'utils/assets.utils';
import { closetFaceImageKey, resolveClosetFaceSource } from 'utils/closet_face';
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

		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		const originalImageUrl = await signClosetOriginalUrl(details.image_key, details.original_image_url);

		const faceSource = resolveClosetFaceSource(details);
		const faceKey = closetFaceImageKey(details);
		const faceUrl = faceKey ? await signDownloadUrlForKey(faceKey) : null;

		let cropIsolateUrl: string | undefined;
		if (originalImageUrl && details.bounding_box) {
			cropIsolateUrl = getIsolatedItemUrl({
				domain,
				imageUrl: originalImageUrl,
				imageKey: details.image_key,
				boundingBox: details.bounding_box,
				dimensions: { width: 1000, height: 1000 },
				enhance,
				color: details.color,
				subcategory: details.subcategory,
			});
		}
		const isolatedImageUrl = faceUrl || cropIsolateUrl;

		const enrichedHistory = await Promise.all(
			details.wear_history.map(async (event) => {
				const eventOriginalUrl = await signClosetOriginalUrl(event.image_key, event.original_image_url);
				return {
					...event,
					original_image_url: eventOriginalUrl || event.original_image_url,
					isolated_image_url: getIsolatedItemUrl({
						domain,
						imageUrl: eventOriginalUrl || event.original_image_url,
						imageKey: event.image_key,
						boundingBox: event.bounding_box,
						dimensions: { width: 1000, height: 1000 }
					})
				};
			})
		);

		const enrichedDetails = {
			...details,
			original_image_url: originalImageUrl,
			face_source: faceSource,
			isolated_image_url: isolatedImageUrl,
			crop_image_url: cropIsolateUrl,
			wear_history: enrichedHistory,
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
