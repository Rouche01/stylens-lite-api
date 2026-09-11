import { error, RequestHandler } from 'itty-router';
import { createOutfitExtractionService } from 'services/outfit_extraction.svc';
import { getIsolatedItemUrl, signDownloadUrlForKey } from 'utils/assets.utils';
import { createClosetDB, createUsersDB } from 'db';
import { env } from 'cloudflare:workers';
import { ApiRequest, AuthRequest } from 'types';
import { logRouteError } from 'utils/error';

type ExtractOutfitBody = {
	imageUrl?: string;
	imageKey?: string;
	userId?: string;
};

const extractOutfitHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as ExtractOutfitBody;
		const imageKeyParam = body.imageKey?.trim();
		let imageUrl = body.imageUrl?.trim();

		if (imageKeyParam && !imageUrl) {
			imageUrl = await signDownloadUrlForKey(imageKeyParam);
		}

		if (!imageUrl) {
			return error(400, 'imageUrl is required to extract from an outfit (or imageKey for admin)');
		}

		let userId: string | undefined;
		if (request.isAdmin) {
			userId = body.userId?.trim();
			if (!userId) {
				return error(400, 'userId is required when extracting with an admin API key');
			}
			const user = await createUsersDB(env.GOSTYLENS_DB).getUserById(userId);
			if (!user) {
				return error(404, 'User not found');
			}
		} else {
			userId = (request as AuthRequest).user?.dbId;
			if (!userId) {
				return error(401, 'Unauthorized: User profile not found in database. Please complete onboarding.');
			}
		}

		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const outfitExtractionService = createOutfitExtractionService(env, request.log);

		const extractedOutfitResult = await outfitExtractionService.extractOutfitItems({
			imageUrl,
			signal: request.signal
		});

		if (!extractedOutfitResult) {
			request.log.warn('outfit_extraction_empty_result');
			return error(400, 'Failed to extract outfit items');
		}

		let imageKey = imageKeyParam || imageUrl;
		try {
			if (!imageKeyParam && imageUrl.startsWith('http')) {
				const url = new URL(imageUrl);
				imageKey = url.pathname.slice(1);
			}
		} catch (e) {
			// Fallback to imageUrl
		}

		const outfit = await closetDB.createOutfit(userId, imageUrl, imageKey);

		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;

		const enrichedItems = [];
		for (const item of extractedOutfitResult.items) {
			let closetItemId: string;
			let isNewClosetItem = false;

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

			await closetDB.linkClosetItemToOutfit({
				outfitId: outfit.id,
				closetItemId,
				boundingBox: item.bounding_box,
				confidence: item.confidence
			});

			enrichedItems.push({
				...item,
				closet_item_id: closetItemId,
				is_new_closet_item: isNewClosetItem,
				isolated_image_url: getIsolatedItemUrl({
					domain,
					imageUrl,
					imageKey,
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
		logRouteError(request.log, 'extract_outfit_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default extractOutfitHandler;
