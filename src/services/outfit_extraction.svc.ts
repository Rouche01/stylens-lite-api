import { createLLMService, LLMService } from './llm.svc';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { OUTFIT_EXTRACTION_RESPONSE_FORMAT } from '../llm/schemas/outfit_extraction.schema';
import { OUTFIT_EXTRACTION_SYSTEM_PROMPT } from '../llm/prompts/outfit_extraction';
import { MessageEntry } from 'utils/types';
import { OutfitExtractionResponse } from 'types';
import { getImageDimensions, getImageMimeType } from '../utils/image.utils';
import { fetchImageAsArrayBuffer, arrayBufferToBase64 } from 'utils/assets.utils';

export type ExtractOutfitItemParams = {
	imageUrl: string;
	signal?: AbortSignal;
};

export class OutfitExtractionService {
	constructor(
		private llmService: LLMService
	) { }

	async extractOutfitItems(params: ExtractOutfitItemParams): Promise<OutfitExtractionResponse | null> {
		const { imageUrl, signal } = params;

		try {
			// 1. Fetch image buffer exactly once
			const imageBuffer = await fetchImageAsArrayBuffer(imageUrl);

			// 2. Extract dimensions and media type in microseconds
			const dimensions = await getImageDimensions(imageBuffer);
			const mimeType = getImageMimeType(imageBuffer);

			// 3. Convert to high-performance base64 data URL
			const base64 = arrayBufferToBase64(imageBuffer);
			const dataUrl = `data:${mimeType};base64,${base64}`;

			// 4. Pass the data URL directly to the LLM preparation layer
			const messages: MessageEntry[] = [
				{
					role: 'user',
					prompt: OUTFIT_EXTRACTION_SYSTEM_PROMPT,
					remoteImage: { url: dataUrl, key: '' },
				},
			];

			const preparedInput = await this.llmService.prepareMessagesForLLM(messages, 'base64');

			const outputs = await this.llmService.generateResponse(
				preparedInput,
				signal,
				OUTFIT_EXTRACTION_RESPONSE_FORMAT
			);

			const parsed = LLMService.extractJSON<{ items: OutfitExtractionResponse['items'] }>(outputs);
			const items = parsed?.items;

			if (!items || !Array.isArray(items)) {
				console.warn('OutfitExtractionService: LLM response did not contain items array', parsed);
				return null;
			}

			return {
				items,
				item_count: items.length,
				image_url: imageUrl,
				extracted_at: new Date().toISOString(),
				image_dimensions: dimensions
			};
		} catch (error) {
			console.error('Failed to extract outfit items:', error);
			return null;
		}
	}
}

export const createOutfitExtractionService = () => {
	const llmService = createLLMService({ useCase: ModelUseCase.OUTFIT_EXTRACTION, provider: ModelProvider.CLAUDE });
	return new OutfitExtractionService(llmService);
};

