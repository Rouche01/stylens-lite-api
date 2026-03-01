import { error, RequestHandler } from 'itty-router';
import { createOutfitExtractionService } from 'services/outfit_extraction.svc';

type AnalyzeOutfitBody = {
	imageUrl: string;
};

const analyzeOutfitHandler: RequestHandler = async (request) => {
	try {
		const body = (await request.json()) as AnalyzeOutfitBody;

		if (!body.imageUrl) {
			return error(400, 'imageUrl is required to analyze an outfit');
		}

		const outfitExtractionService = createOutfitExtractionService();

		const extractedOutfitItems = await outfitExtractionService.extractOutfitItems({ imageUrl: body.imageUrl, signal: request.signal });

		return new Response(JSON.stringify({ message: `Outfit analysis started for ${body.imageUrl}`, extractedOutfitItems }), {
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

export default analyzeOutfitHandler;
