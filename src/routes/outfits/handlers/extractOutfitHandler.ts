import { error, RequestHandler } from 'itty-router';
import { createOutfitExtractionService } from 'services/outfit_extraction.svc';

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

		const extractedOutfitItems = await outfitExtractionService.extractOutfitItems({
			imageUrl: body.imageUrl,
			signal: request.signal
		});

		return new Response(JSON.stringify({ message: `Outfit extraction started for ${body.imageUrl}`, extractedOutfitItems }), {
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
