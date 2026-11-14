import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createClosetDB, createUsersDB } from 'db';
import { assertEvalUserAllowed, EvalUserResetError } from 'services/identity/eval/resetEvalUser';
import { ApiRequest } from 'types';
import {
	CLOSET_TILE_ISOLATE_WIDTH,
	getIsolatedItemUrl,
	signClosetOriginalUrl,
	signDownloadUrlForKey,
} from 'utils/assets.utils';
import { isClosetBrowseItem } from 'utils/closet_browse';
import { resolveClosetFaceSource } from 'utils/closet_face';
import { logRouteError } from 'utils/error';
import { CLOSET_SCREEN_FALLBACK_ASPECT, renderClosetFaceGalleryHtml } from './closetPreviewHtml';

/**
 * Admin judge surface: crop vs stored cutout vs stored packshot for EVAL_USER_ID.
 * GET /closet/eval/faces?userId=&admin_key=
 */
const evalClosetFacesHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const requestUrl = new URL(request.url);
		const userId = requestUrl.searchParams.get('userId')?.trim() || '';
		if (!userId) {
			return error(400, 'userId is required');
		}

		assertEvalUserAllowed(env, userId);

		const user = await createUsersDB(env.GOSTYLENS_DB).getUserById(userId);
		if (!user) {
			return error(404, 'User not found');
		}

		const closet = createClosetDB(env.GOSTYLENS_DB);
		const items = (await closet.getClosetItems(userId)).filter(isClosetBrowseItem);
		const domain = requestUrl.origin;

		const rows = await Promise.all(
			items.map(async (item) => {
				const originalImageUrl = await signClosetOriginalUrl(item.image_key, item.original_image_url);
				const cropUrl =
					originalImageUrl && item.bounding_box
						? getIsolatedItemUrl({
								domain,
								imageUrl: originalImageUrl,
								imageKey: item.image_key,
								boundingBox: item.bounding_box,
								width: CLOSET_TILE_ISOLATE_WIDTH,
								cutout: false,
								category: item.category,
							})
						: '';
				const cutoutUrl = item.cutout_image_key?.trim()
					? await signDownloadUrlForKey(item.cutout_image_key.trim())
					: '';
				const flatlayUrl = item.flatlay_image_key?.trim()
					? await signDownloadUrlForKey(item.flatlay_image_key.trim())
					: '';
				const ratio =
					item.tile_aspect_ratio != null && item.tile_aspect_ratio > 0
						? item.tile_aspect_ratio
						: CLOSET_SCREEN_FALLBACK_ASPECT;

				return {
					id: item.id,
					label: item.label,
					subtitle: `${item.color || ''} ${item.subcategory || ''}`.trim(),
					faceSource: resolveClosetFaceSource(item),
					cropUrl,
					cutoutUrl: cutoutUrl || '',
					flatlayUrl: flatlayUrl || '',
					aspectRatio: ratio,
					previewHref: `/closet/items/${encodeURIComponent(item.id)}/preview?layout=face`,
				};
			})
		);

		const wantJson =
			requestUrl.searchParams.get('format') === 'json' ||
			(request.headers.get('accept') || '').includes('application/json');

		if (wantJson) {
			return new Response(
				JSON.stringify({
					user_id: userId,
					item_count: rows.length,
					items: rows,
				}),
				{
					headers: {
						'Content-Type': 'application/json; charset=utf-8',
						'Cache-Control': 'no-store',
					},
				}
			);
		}

		const html = renderClosetFaceGalleryHtml({
			title: 'Eval closet faces',
			subtitle: `user ${userId.slice(0, 8)}… · ${rows.length} browse items · crop vs stored cutout vs packshot`,
			userId,
			items: rows,
		});

		return new Response(html, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	} catch (err) {
		if (err instanceof EvalUserResetError) {
			return error(err.status, err.message);
		}
		logRouteError(request.log, 'eval_closet_faces_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default evalClosetFacesHandler;
