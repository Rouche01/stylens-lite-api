import { createLLMService, LLMService } from './llm.svc';
import { ModelUseCase } from './model_config.svc';
import { OUTFIT_EXTRACTION_RESPONSE_FORMAT } from '../llm/schemas/outfit_extraction.schema';
import { OUTFIT_EXTRACTION_SYSTEM_PROMPT, OUTFIT_EXTRACTION_USER_PROMPT } from '../llm/prompts/outfit_extraction';
import { MessageEntry } from 'utils/types';

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
		const messages: MessageEntry[] = [
			{
				role: 'system',
				prompt: OUTFIT_EXTRACTION_SYSTEM_PROMPT,
			},
			{
				role: 'user',
				prompt: OUTFIT_EXTRACTION_USER_PROMPT,
				remoteImage: { url: imageUrl, key: '' },
			},
		];

		const preparedInput = await this.llmService.prepareMessagesForLLM(messages);

		const res = await this.llmService.generateResponse(
			preparedInput,
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
