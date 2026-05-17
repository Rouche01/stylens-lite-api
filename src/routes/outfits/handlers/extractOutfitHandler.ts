import { error, RequestHandler } from 'itty-router';
import { createOutfitExtractionService } from 'services/outfit_extraction.svc';
import { getIsolatedItemUrl } from 'utils/assets.utils';

type ExtractOutfitBody = {
	imageUrl: string;
};

const extractOutfitHandler: RequestHandler = async (request) => {
	try {
		const body = (await request.json()) as ExtractOutfitBody;

		if (!body.imageUrl) {
			return error(400, 'imageUrl is required to extract from an outfit');
		}

		const outfitExtractionService = createOutfitExtractionService();

		const extractedOutfitResult = await outfitExtractionService.extractOutfitItems({
			imageUrl: body.imageUrl,
			signal: request.signal
		});

		if (!extractedOutfitResult) {
			return error(400, 'Failed to extract outfit items');
		}

		// Get current worker host domain dynamically from the request URL
		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;

		// Enrich each extracted clothing item with its dynamic Cloudflare CDN isolation URL
		const itemsWithIsolatedUrls = extractedOutfitResult.items.map(item => ({
			...item,
			isolated_image_url: getIsolatedItemUrl({
				domain,
				imageUrl: body.imageUrl,
				boundingBox: item.bounding_box,
				dimensions: extractedOutfitResult.image_dimensions
			})
		}));

		const enrichedPayload = {
			...extractedOutfitResult,
			items: itemsWithIsolatedUrls
		};

		return new Response(JSON.stringify(enrichedPayload), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default extractOutfitHandler;
