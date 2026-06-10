import { error, RequestHandler } from 'itty-router';
import { createOutfitExtractionService } from 'services/outfit_extraction.svc';
import { getIsolatedItemUrl } from 'utils/assets.utils';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';

type ExtractOutfitBody = {
	imageUrl: string;
};

const extractOutfitHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const body = (await request.json()) as ExtractOutfitBody;

		if (!body.imageUrl) {
			return error(400, 'imageUrl is required to extract from an outfit');
		}

		const userId = request.user.dbId;
		const closetDB = createClosetDB(env.GOSTYLENS_DB);

		const outfitExtractionService = createOutfitExtractionService();

		const extractedOutfitResult = await outfitExtractionService.extractOutfitItems({
			imageUrl: body.imageUrl,
			signal: request.signal
		});

		if (!extractedOutfitResult) {
			return error(400, 'Failed to extract outfit items');
		}

		// 1. Extract clean R2 image key from imageUrl
		let imageKey = body.imageUrl;
		try {
			if (body.imageUrl.startsWith('http')) {
				const url = new URL(body.imageUrl);
				imageKey = url.pathname.slice(1);
			}
		} catch (e) {
			// Fallback to imageUrl
		}

		// 2. Save the raw Outfit event
		const outfit = await closetDB.createOutfit(userId, body.imageUrl, imageKey);

		// Get current worker host domain dynamically from the request URL
		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;

		// 3. Process each extracted clothing item: deduplicate, save, link, and enrich URLs
		const enrichedItems = [];
		for (const item of extractedOutfitResult.items) {
			let closetItemId: string;
			let isNewClosetItem = false;

			// Check for duplicate closet items (by attributes)
			const matchedItem = await closetDB.findMatchingClosetItem({
				userId,
				category: item.category,
				subcategory: item.subcategory,
				color: item.color,
				pattern: item.pattern
			});

			if (matchedItem) {
				closetItemId = matchedItem.id;
			} else {
				// Create new persistent closet item
				const newItem = await closetDB.createClosetItem({
					userId,
					label: item.label,
					category: item.category,
					subcategory: item.subcategory,
					color: item.color,
					pattern: item.pattern,
					styleTags: item.style_tags || []
				});
				closetItemId = newItem.id;
				isNewClosetItem = true;
			}

			// Link the closet item to this outfit with bounding box coordinates
			await closetDB.linkClosetItemToOutfit({
				outfitId: outfit.id,
				closetItemId,
				boundingBox: item.bounding_box,
				confidence: item.confidence
			});

			// Enrich item response
			enrichedItems.push({
				...item,
				closet_item_id: closetItemId,
				is_new_closet_item: isNewClosetItem,
				isolated_image_url: getIsolatedItemUrl({
					domain,
					imageUrl: body.imageUrl,
					boundingBox: item.bounding_box,
					dimensions: extractedOutfitResult.image_dimensions
				})
			});
		}

		const enrichedPayload = {
			...extractedOutfitResult,
			outfit_id: outfit.id,
			items: enrichedItems
		};

		return new Response(JSON.stringify(enrichedPayload), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		console.error('Failed to extract outfit items:', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default extractOutfitHandler;
