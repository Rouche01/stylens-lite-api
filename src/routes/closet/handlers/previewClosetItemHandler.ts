import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { OutfitLinkedItem } from 'db/closet';
import { env } from 'cloudflare:workers';
import { ApiRequest } from 'types';
import { signClosetOriginalUrl } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';
import { PreviewBox, renderClosetPreviewHtml } from './closetPreviewHtml';

const previewClosetItemHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const itemId = request.params.id;
		if (!itemId) {
			return error(400, 'Closet item ID is required');
		}

		const requestUrl = new URL(request.url);
		const showAll = requestUrl.searchParams.get('all') === '1';
		const outfitIdParam = requestUrl.searchParams.get('outfit_id')?.trim() || undefined;

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

		return new Response(html, {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	} catch (err) {
		logRouteError(request.log, 'preview_closet_item_failed', err, { item_id: request.params.id });
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default previewClosetItemHandler;
