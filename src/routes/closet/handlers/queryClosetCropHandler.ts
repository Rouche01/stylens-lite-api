import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createOutfitIdentityService } from 'services/identity';
import { logRouteError } from 'utils/error';
import { ApiRequest } from 'types';
import { identityRouteError, parseIdentityCrop, type IdentityCropBody } from './identityCropBody';

/**
 * TEMP admin smoke test: crop, embed, query Vectorize nearest neighbors (cosine, higher = closer).
 * Wait ~5–10s after upsert before querying.
 *
 * POST /closet/identity/query
 * Header: x-admin-api-key
 * Body: { imageKey, boundingBox, userId?, category?, topK? }
 * `category` is not used as a Vectorize filter (Claude labels disagree across photos).
 * Search is userId + identity slot + encoder, then crop-color rerank (identity_score).
 * Slot maps top+outerwear → upper so a jacket mislabeled "top" still matches; jeans do not.
 * `score` is cosine. `neighbors` is every Vectorize hit with identity_score and color_distance.
 * `matches` is neighbors with identity_score ≥ 0.5 (not a silent-merge decision).
 * Each match includes Vectorize id, score, closet_item_id (vector metadata),
 * plus d1_closet_item_id / d1_label when that id exists in closet_items.
 * probe_d1_* is the D1 item on the query photo (box overlap).
 */
const queryClosetCropHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as IdentityCropBody;
		const parsed = parseIdentityCrop(body);
		if ('error' in parsed) {
			return error(400, parsed.error);
		}

		const identityService = createOutfitIdentityService(env, request.log);
		const result = await identityService.queryClosetCrop({
			imageKey: parsed.imageKey,
			boundingBox: parsed.boundingBox,
			signal: request.signal,
			userId: body.userId?.trim() || undefined,
			category: body.category?.trim() || undefined,
			topK: typeof body.topK === 'number' ? body.topK : undefined,
		});

		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		logRouteError(request.log, 'admin_identity_query_failed', err);
		return identityRouteError(
			err,
			'Request body must be JSON: { imageKey, boundingBox, userId?, category?, topK? }'
		);
	}
};

export default queryClosetCropHandler;
