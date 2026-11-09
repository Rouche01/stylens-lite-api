import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createOutfitIdentityService } from 'services/identity';
import { logRouteError } from 'utils/error';
import { ApiRequest } from 'types';
import { identityRouteError, parseIdentityCrop, type IdentityCropBody } from './identityCropBody';

/**
 * TEMP admin smoke test: crop + embed one Florence box.
 * Pass userId + category to also upsert into Vectorize (queryable after ~5–10s).
 *
 * POST /closet/identity/embed
 * Header: x-admin-api-key
 * Body: { imageKey, boundingBox, userId?, category?, id?, closetItemId? }
 */
const embedClosetCropHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as IdentityCropBody;
		const parsed = parseIdentityCrop(body);
		if ('error' in parsed) {
			return error(400, parsed.error);
		}

		const userId = body.userId?.trim();
		const category = body.category?.trim();
		if ((userId && !category) || (category && !userId)) {
			return error(400, 'userId and category are both required to upsert');
		}

		const identityService = createOutfitIdentityService(env, request.log);
		const crop = {
			imageKey: parsed.imageKey,
			boundingBox: parsed.boundingBox,
			signal: request.signal,
		};
		const result = userId && category
			? await identityService.upsertClosetCrop({
					...crop,
					userId,
					category,
					id: body.id?.trim() || undefined,
					closetItemId: body.closetItemId?.trim() || undefined,
				})
			: await identityService.embedClosetCrop(crop);

		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		logRouteError(request.log, 'admin_identity_embed_failed', err);
		return identityRouteError(
			err,
			'Request body must be JSON: { imageKey, boundingBox, userId?, category?, id?, closetItemId? }'
		);
	}
};

export default embedClosetCropHandler;
