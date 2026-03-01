import { env } from 'cloudflare:workers';
import { LLMService } from './llm.svc';

export type OutfitItem = {
	category: 'outerwear' | 'top' | 'bottom' | 'dress' | 'shoes' | 'accessories';
	subcategory: string;
	color: string;
	material: string | null;
	style: string[];
	confidence: number;
};

export type ExtractOutfitItemParams = {
	imageUrl: string;
	signal?: AbortSignal;
};

export type OutfitExtractionResult = {
	items: OutfitItem[];
};

export class OutfitExtractionService {
	static SYSTEM_PROMPT = `
        You are a fashion computer vision system.

        Your task:
        - Identify all visible clothing items worn by the person.
        - Ignore background objects.
        - Treat layered clothing as separate items.

        Output rules:
        - Output valid JSON only.
        - No explanations.
        - No markdown.
        - No extra keys.

        If you are unsure about an attribute, set it to null.
    `.trim();

	static USER_PROMPT = 'Extract all clothing items from this image.';

	static OUTFIT_EXTRACTION_SCHEMA = {
		type: 'object',
		additionalProperties: false,
		properties: {
			items: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						category: {
							type: 'string',
							enum: ['outerwear', 'top', 'bottom', 'dress', 'shoes', 'accessories'],
						},
						subcategory: { type: 'string' },
						color: { type: 'string' },
						material: { type: ['string', 'null'] },
						style: {
							type: 'array',
							items: { type: 'string' },
						},
						confidence: {
							type: 'number',
							minimum: 0,
							maximum: 1,
						},
					},
					required: ['category', 'subcategory', 'color', 'material', 'style', 'confidence'],
				},
			},
		},
		required: ['items'],
	};

	constructor(private llmService: LLMService) {}

	async extractOutfitItems({ imageUrl, signal }: ExtractOutfitItemParams): Promise<OutfitExtractionResult | null> {
		const res = await this.llmService.generateResponse(
			[
				{
					role: 'system',
					content: OutfitExtractionService.SYSTEM_PROMPT,
				},
				{
					role: 'user',
					content: [
						{ type: 'input_text', text: OutfitExtractionService.USER_PROMPT },
						{
							type: 'input_image',
							image_url: imageUrl,
						},
					],
				},
			],
			signal,
			{ type: 'json_schema', name: 'OutfitExtraction', schema: OutfitExtractionService.OUTFIT_EXTRACTION_SCHEMA },
		);

		const resultText = res[0]?.text;
		let outfitItems: OutfitExtractionResult | null = null;
		try {
			outfitItems = resultText ? (JSON.parse(resultText) as OutfitExtractionResult) : null;
		} catch (e) {
			console.error('Failed to parse outfit extraction result:', e);
		}

		return outfitItems;
	}
}

export const createOutfitExtractionService = () => {
	const llmService = new LLMService(env.OUTFIT_EXTRACTION_MODEL_ENDPOINT, env.OUTFIT_EXTRACTION_MODEL_API_KEY, env.OUTFIT_EXTRACTION_MODEL);
	return new OutfitExtractionService(llmService);
};
