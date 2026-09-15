import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { OutfitLinkedItem } from 'db/closet';
import { env } from 'cloudflare:workers';
import { ApiRequest } from 'types';
import {
	CLOSET_PREVIEW_CROP_WIDTH,
	CLOSET_TILE_ISOLATE_WIDTH,
	getIsolatedItemUrl,
	signClosetOriginalUrl,
} from 'utils/assets.utils';
import { boxInCrop, closetTilePad, nativeAspectFocusWindow, padPercentBox } from 'utils/bounding_box';
import { getImageDimensions } from 'utils/image.utils';
import { logRouteError } from 'utils/error';
import {
	CLOSET_SCREEN_FALLBACK_ASPECT,
	PreviewBox,
	renderClosetPreviewHtml,
	renderClosetScreenHtml,
} from './closetPreviewHtml';

const previewClosetItemHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const itemId = request.params.id;
		if (!itemId) {
			return error(400, 'Closet item ID is required');
		}

		const requestUrl = new URL(request.url);
		const showAll = requestUrl.searchParams.get('all') === '1';
		const outfitIdParam = requestUrl.searchParams.get('outfit_id')?.trim() || undefined;
		const closetLayout = requestUrl.searchParams.get('layout') === 'closet';
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const details = await closetDB.getClosetItemDetailsById(itemId);
		if (!details) {
			return error(404, 'Closet item not found');
		}

		const wear = outfitIdParam
			? details.wear_history.find((event) => event.outfit_id === outfitIdParam)
			: details.wear_history[0];

		if (!wear) {
			return error(404, outfitIdParam ? 'outfit_id is not in this item wear history' : 'No outfit photo linked to this closet item');
		}

		const imageUrl = await signClosetOriginalUrl(wear.image_key, wear.original_image_url);
		if (!imageUrl) {
			return error(404, 'No outfit photo linked to this closet item');
		}

		if (closetLayout) {
			const catalog = await closetDB.getClosetItems(details.user_id);
			const listed = catalog.find((item) => item.id === itemId);
			const ratio =
				listed?.tile_aspect_ratio != null && listed.tile_aspect_ratio > 0
					? listed.tile_aspect_ratio
					: CLOSET_SCREEN_FALLBACK_ASPECT;
			const cropUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: wear.bounding_box,
				width: CLOSET_PREVIEW_CROP_WIDTH,
				cutout: false,
				category: details.category,
			});
			const isolateUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: wear.bounding_box,
				width: CLOSET_TILE_ISOLATE_WIDTH,
				enhance,
			});
			const paddedBox = padPercentBox(wear.bounding_box, closetTilePad(details.category));
			const photoSize = await outfitPhotoSize(wear.image_key, wear.image_width, wear.image_height);
			const focus = photoSize
				? nativeAspectFocusWindow(wear.bounding_box, photoSize.width, photoSize.height, details.category)
				: { x: 0, y: 0, width: 100, height: 100 };
			const itemCropUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: focus,
				width: CLOSET_PREVIEW_CROP_WIDTH,
				cutout: false,
				pad: false,
			});
			const seedInCrop = boxInCrop(wear.bounding_box, focus) ?? wear.bounding_box;
			const html = renderClosetScreenHtml({
				title: details.label,
				subtitle: `${details.color} ${details.subcategory}`.trim(),
				itemId,
				label: details.label,
				cropUrl,
				isolateUrl,
				originalUrl: imageUrl,
				itemCropUrl,
				paddedBox,
				seedBox: seedInCrop,
				aspectRatio: ratio,
				aspectFallback: listed?.tile_aspect_ratio == null || listed.tile_aspect_ratio <= 0,
				blurHash: listed?.blur_hash || '',
				photoWidth: photoSize?.width ?? wear.image_width,
				photoHeight: photoSize?.height ?? wear.image_height,
			});
			return previewHtml(html);
		}

		let boxes: PreviewBox[];
		if (showAll) {
			const linked: OutfitLinkedItem[] = await closetDB.getOutfitLinkedItems(wear.outfit_id);
			boxes = linked.map((item) => ({
				closet_item_id: item.closet_item_id,
				label: item.label,
				color: item.color,
				bounding_box: item.bounding_box,
				highlighted: item.closet_item_id === itemId,
			}));
		} else {
			boxes = [
				{
					closet_item_id: details.id,
					label: details.label,
					color: details.color,
					bounding_box: wear.bounding_box,
					highlighted: true,
				},
			];
		}

		const html = renderClosetPreviewHtml({
			title: details.label,
			subtitle: showAll
				? `All items on outfit ${wear.outfit_id}`
				: `${details.color} ${details.subcategory}`.trim(),
			imageUrl,
			boxes,
			showAll,
		});

		return previewHtml(html);
	} catch (err) {
		logRouteError(request.log, 'preview_closet_item_failed', err, { item_id: request.params.id });
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

async function outfitPhotoSize(
	imageKey: string | undefined,
	storedW: number | null,
	storedH: number | null
): Promise<{ width: number; height: number } | null> {
	if (storedW != null && storedW > 0 && storedH != null && storedH > 0) {
		return { width: storedW, height: storedH };
	}
	if (!imageKey) return null;
	try {
		const obj = await env.OUTFIT_PHOTOS_BUCKET.get(imageKey);
		if (!obj) return null;
		const dims = await getImageDimensions(await obj.arrayBuffer());
		if (!(dims.width > 0) || !(dims.height > 0)) return null;
		return dims;
	} catch {
		return null;
	}
}

function previewHtml(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

export default previewClosetItemHandler;
