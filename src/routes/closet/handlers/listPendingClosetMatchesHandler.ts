import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ApiRequest } from 'types';
import { getIsolatedItemUrl, signClosetOriginalUrl } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';
import { isErrorResponse, requireClosetUserId } from './closetUser';
import { pendingClosetMatchClientPayload } from './pendingClosetMatchPayload';

const listPendingClosetMatchesHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const requestUrl = new URL(request.url);
		const userIdOrError = await requireClosetUserId(request, requestUrl.searchParams.get('userId') ?? undefined);
		if (isErrorResponse(userIdOrError)) return userIdOrError;
		const userId = userIdOrError;

		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const pending = await closetDB.listPendingMatches(userId);
		const domain = requestUrl.host;
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		const matches = await Promise.all(
			pending.map(async (match) => {
				const snapshot = match.extract_snapshot;
				const probeOriginalUrl = await signClosetOriginalUrl(
					match.outfit_image_key,
					match.outfit_original_image_url
				);
				const candidateDetails = await closetDB.getClosetItemDetails(userId, match.candidate_closet_item_id);
				const candidateOriginalUrl = candidateDetails
					? await signClosetOriginalUrl(candidateDetails.image_key, candidateDetails.original_image_url)
					: undefined;

				return pendingClosetMatchClientPayload(match, {
					probeOriginalUrl,
					probeIsolatedUrl:
						probeOriginalUrl && match.bounding_box
							? getIsolatedItemUrl({
									domain,
									imageUrl: probeOriginalUrl,
									imageKey: match.outfit_image_key,
									boundingBox: match.bounding_box,
									dimensions: { width: 1000, height: 1000 },
									enhance,
									color: snapshot.color,
									subcategory: snapshot.subcategory,
								})
							: undefined,
					candidateDetails,
					candidateOriginalUrl,
					candidateIsolatedUrl:
						candidateOriginalUrl && candidateDetails?.bounding_box
							? getIsolatedItemUrl({
									domain,
									imageUrl: candidateOriginalUrl,
									imageKey: candidateDetails.image_key,
									boundingBox: candidateDetails.bounding_box,
									dimensions: { width: 1000, height: 1000 },
									enhance,
									color: candidateDetails.color,
									subcategory: candidateDetails.subcategory,
								})
							: undefined,
				});
			})
		);

		return new Response(JSON.stringify({ matches }), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		logRouteError(request.log, 'list_pending_closet_matches_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default listPendingClosetMatchesHandler;
