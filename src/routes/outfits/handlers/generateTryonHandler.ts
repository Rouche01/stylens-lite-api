import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createTryonService, isClothType, TryonError } from 'services/tryon';
import { signDownloadUrlForKey } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';
import { ApiRequest } from 'types';

/**
 * TEMP admin test hook: Stage 4 try-on in-request (no queue, no D1).
 *
 * POST /outfits/tryon/generate
 * Header: x-admin-api-key
 * Body: { avatarImageKey, garmentImageKey, clothType }
 * clothType: upper | lower | overall | inner | outer
 * Cutout is flattened onto white and sent to FASHN as a flat-lay garment.
 * Layer a second item by passing the previous render image_key as avatarImageKey.
 */
type GenerateTryonBody = {
	avatarImageKey?: string;
	garmentImageKey?: string;
	clothType?: string;
};

const generateTryonHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as GenerateTryonBody;
		const avatarImageKey = body.avatarImageKey?.trim();
		const garmentImageKey = body.garmentImageKey?.trim();
		const clothType = body.clothType?.trim().toLowerCase();

		if (!avatarImageKey) {
			return error(400, 'avatarImageKey is required (ready twin R2 key, or a previous try-on render)');
		}
		if (!garmentImageKey) {
			return error(400, 'garmentImageKey is required (cutout R2 key)');
		}
		if (!clothType || !isClothType(clothType)) {
			return error(400, 'clothType must be one of: upper, lower, overall, inner, outer');
		}

		const tryonService = createTryonService(env, request.log);
		const result = await tryonService.tryOnFromR2({
			avatarImageKey,
			garmentImageKey,
			clothType,
		});

		const scratchKey = `tryon/scratch/${crypto.randomUUID()}.png`;
		await env.OUTFIT_PHOTOS_BUCKET.put(scratchKey, result.pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});

		const imageUrl = await signDownloadUrlForKey(scratchKey);

		return new Response(
			JSON.stringify({
				message: 'Try-on generated',
				image_key: scratchKey,
				image_url: imageUrl,
				avatar_image_key: result.avatarImageKey,
				garment_image_key: result.garmentImageKey,
				cloth_type: result.clothType,
				category: result.category,
				model: result.model,
			}),
			{
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (err) {
		logRouteError(request.log, 'admin_generate_tryon_failed', err);
		if (err instanceof SyntaxError) {
			return error(400, 'Request body must be JSON: { avatarImageKey, garmentImageKey, clothType }');
		}
		if (err instanceof TryonError) {
			if (err.status === 403) return error(403, err.message);
			if (err.status === 404) return error(404, err.message);
			if (err.status === 422) return error(422, err.message);
			const status = err.isRetryable ? 502 : 400;
			return error(status, err.message);
		}
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default generateTryonHandler;
