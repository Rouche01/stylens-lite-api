import { env } from 'cloudflare:workers';
import { createLLMService, LLMService } from './llm.svc';
import { ModelUseCase } from './model_config.svc';
import { OUTFIT_EXTRACTION_RESPONSE_FORMAT } from '../llm/schemas/outfit_extraction.schema';
import { OUTFIT_EXTRACTION_SYSTEM_PROMPT, OUTFIT_EXTRACTION_USER_PROMPT } from '../llm/prompts/outfit_extraction';

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
	constructor(private llmService: LLMService) { }

	async extractOutfitItems({ imageUrl, signal }: ExtractOutfitItemParams): Promise<OutfitExtractionResult | null> {
		const res = await this.llmService.generateResponse(
			[
				{
					role: 'system',
					content: OUTFIT_EXTRACTION_SYSTEM_PROMPT,
				},
				{
					role: 'user',
					content: [
						{ type: 'input_text', text: OUTFIT_EXTRACTION_USER_PROMPT },
						{
							type: 'input_image',
							image_url: imageUrl,
						},
					],
				},
			],
			signal,
			OUTFIT_EXTRACTION_RESPONSE_FORMAT,
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
	const llmService = createLLMService({ useCase: ModelUseCase.OUTFIT_EXTRACTION })
	return new OutfitExtractionService(llmService);
};
