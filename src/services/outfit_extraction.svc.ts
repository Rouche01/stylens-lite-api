import { createLLMService, LLMService } from './llm.svc';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { OUTFIT_EXTRACTION_RESPONSE_FORMAT } from '../llm/schemas/outfit_extraction.schema';
import { OUTFIT_EXTRACTION_SYSTEM_PROMPT, OUTFIT_EXTRACTION_USER_PROMPT } from '../llm/prompts/outfit_extraction';
import { MessageEntry } from 'utils/types';
import { env } from 'cloudflare:workers';

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
	constructor(
		private llmService: LLMService,
		private r2Bucket?: R2Bucket
	) { }

	private async fetchImageFromR2(imageUrlOrKey: string): Promise<{ imageBase64: string; mediaType: string } | null> {
		if (!this.r2Bucket) {
			console.warn('R2 bucket binding is not provided to OutfitExtractionService');
			return null;
		}

		let key = imageUrlOrKey;
		// If it's a full URL, extract the path as the key
		if (key.startsWith('http://') || key.startsWith('https://')) {
			try {
				const url = new URL(key);
				key = url.pathname.slice(1);
			} catch (e) {
				console.error('Invalid URL format:', key);
				return null;
			}
		}

		try {
			const object = await this.r2Bucket.get(key);
			if (!object) {
				console.error(`Image not found in R2 for key: ${key}`);
				return null;
			}

			const buffer = await object.arrayBuffer();

			// Convert ArrayBuffer to Base64
			let binary = '';
			const bytes = new Uint8Array(buffer);
			const len = bytes.byteLength;
			for (let i = 0; i < len; i++) {
				binary += String.fromCharCode(bytes[i]);
			}
			const imageBase64 = btoa(binary);

			const mediaType = object.httpMetadata?.contentType || 'image/jpeg';

			return { imageBase64, mediaType };
		} catch (error) {
			console.error(`Failed to fetch image from R2 for key: ${key}`, error);
			return null;
		}
	}

	async extractOutfitItems(params: ExtractOutfitItemParams): Promise<OutfitExtractionResult | null> {
		const { imageUrl, signal } = params;

		const messages: MessageEntry[] = [
			{
				role: 'user',
				prompt: OUTFIT_EXTRACTION_USER_PROMPT,
				remoteImage: { url: imageUrl, key: '' },
			},
		];

		const preparedInput = await this.llmService.prepareMessagesForLLM(messages, 'base64');

		const res = await this.llmService.generateResponse(
			preparedInput,
			signal,
			OUTFIT_EXTRACTION_RESPONSE_FORMAT
		);

		console.log(res);

		return null;

		// const resultText = LLMService.extractText(res);
		// let outfitItems: OutfitExtractionResult | null = null;
		// try {
		// 	outfitItems = resultText ? (JSON.parse(resultText) as OutfitExtractionResult) : null;
		// } catch (e) {
		// 	console.error('Failed to parse outfit extraction result:', e);
		// }

		// return outfitItems;
	}
}

export const createOutfitExtractionService = (providedEnv?: any) => {
	const applicationEnv = providedEnv || env;
	const llmService = createLLMService({ useCase: ModelUseCase.OUTFIT_EXTRACTION, provider: ModelProvider.CLAUDE });
	return new OutfitExtractionService(llmService, applicationEnv?.OUTFIT_PHOTOS_BUCKET);
};
