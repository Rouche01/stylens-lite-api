import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createCutoutService, SegmentError } from 'services/segmentation';
import { signDownloadUrlForKey } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';
import { ApiRequest } from 'types';

/**
 * TEMP admin test hook: run Fal cutout in-request (no queue, no D1).
 * Remove once extract enqueue is wired.
 *
 * POST /outfits/cutouts/generate
 * Header: x-admin-api-key
 * Body: { imageKey, label?, boundingBox? }
 * Need at least label or boundingBox.
 * Label → SAM 3 concept prompts (short noun phrases). Box-only → SAM 2.
 * Prefer label + boundingBox together.
 */
type GenerateCutoutBody = {
	imageKey?: string;
	label?: string;
	boundingBox?: {
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
};

function parsePercentBox(box: GenerateCutoutBody['boundingBox']): { x: number; y: number; width: number; height: number } | undefined {
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

const generateCutoutHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as GenerateCutoutBody;
		const imageKey = body.imageKey?.trim();
		const label = body.label?.trim();
		const boundingBox = parsePercentBox(body.boundingBox);

		if (!imageKey) {
			return error(400, 'imageKey is required');
		}
		if (body.boundingBox != null && !boundingBox) {
			return error(400, 'boundingBox must include numeric x, y, width, height (percents 0-100)');
		}
		if (!label && !boundingBox) {
			return error(400, 'Provide label and/or boundingBox');
		}

		const cutoutService = createCutoutService(env, request.log);
		const result = await cutoutService.cutoutFromR2({
			imageKey,
			label,
			boundingBox,
		});

		const scratchKey = `cutouts/scratch/${crypto.randomUUID()}.png`;
		await env.OUTFIT_PHOTOS_BUCKET.put(scratchKey, result.pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});

		const imageUrl = await signDownloadUrlForKey(scratchKey);

		return new Response(
			JSON.stringify({
				message: 'Cutout generated',
				image_key: scratchKey,
				image_url: imageUrl,
				source_image_key: result.imageKey,
				box_px: result.boxPx,
				image_dimensions: result.imageDimensions,
				model: result.model,
				prompt_used: result.promptUsed || null,
				prompts_tried: result.promptsTried || [],
			}),
			{
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (err) {
		logRouteError(request.log, 'admin_generate_cutout_failed', err);
		if (err instanceof SyntaxError) {
			return error(400, 'Request body must be JSON: { imageKey, label? , boundingBox? }');
		}
		if (err instanceof SegmentError) {
			if (err.status === 403) {
				return error(403, err.message);
			}
			if (err.status === 422) {
				return error(422, err.message);
			}
			const status = err.isRetryable ? 502 : 400;
			return error(status, err.message);
		}
		if (err instanceof Error && /network connection lost/i.test(err.message)) {
			return error(502, 'Fal SAM 2 request failed (network). Retry; large photos should use the signed R2 URL path.');
		}
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default generateCutoutHandler;
