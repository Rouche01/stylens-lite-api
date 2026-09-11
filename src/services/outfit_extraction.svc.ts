import { createLLMService, LLMService } from './llm.svc';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { OUTFIT_EXTRACTION_RESPONSE_FORMAT } from '../llm/schemas/outfit_extraction.schema';
import { OUTFIT_EXTRACTION_SYSTEM_PROMPT, outfitExtractionUserPrompt } from '../llm/prompts/outfit_extraction';
import { MessageEntry } from 'utils/types';
import { ClothingItem, OutfitExtractionResponse } from 'types';
import { getImageDimensions } from '../utils/image.utils';
import { arrayBufferToBase64, fetchImageAsArrayBuffer, signDownloadUrlForKey } from 'utils/assets.utils';
import { orientImageJpeg } from 'utils/cf_images.utils';
import { normalizeOutfitBoundingBox } from 'utils/bounding_box';
import { FlorenceGroundingProvider, GroundingProvider } from './grounding';
import { sam3PromptCandidates } from './segmentation/sam3_prompt';
import { Logger, createLogger } from 'utils/logger.utils';

export type ExtractOutfitItemParams = {
	imageUrl: string;
	signal?: AbortSignal;
};

function groundingPrompts(item: ClothingItem): string[] {
	const prompts = sam3PromptCandidates(item.label);
	const colorNoun = `${item.color} ${item.subcategory}`.replace(/-/g, ' ').trim().toLowerCase();
	if (colorNoun && !prompts.includes(colorNoun)) prompts.unshift(colorNoun);
	return prompts.slice(0, 4);
}

export class OutfitExtractionService {
	constructor(
		private llmService: LLMService,
		private images: ImagesBinding,
		private bucket: R2Bucket,
		private grounding: GroundingProvider | null,
		private log: Logger
	) {}

	async extractOutfitItems(params: ExtractOutfitItemParams): Promise<OutfitExtractionResponse | null> {
		const { imageUrl, signal } = params;
		const log = this.log.child({ service: 'outfit_extraction' });

		try {
			const rawBuffer = await fetchImageAsArrayBuffer(imageUrl);
			const orientedBuffer = await orientImageJpeg(this.images, rawBuffer);
			const dimensions = await getImageDimensions(orientedBuffer);
			const dataUrl = `data:image/jpeg;base64,${arrayBufferToBase64(orientedBuffer)}`;

			const orientKey = `extract/orient/${crypto.randomUUID()}.jpg`;
			await this.bucket.put(orientKey, orientedBuffer, {
				httpMetadata: { contentType: 'image/jpeg' },
			});
			const orientedImageUrl = await signDownloadUrlForKey(orientKey);

			const messages: MessageEntry[] = [
				{
					role: 'system',
					prompt: OUTFIT_EXTRACTION_SYSTEM_PROMPT,
				},
				{
					role: 'user',
					prompt: outfitExtractionUserPrompt(dimensions.width, dimensions.height),
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
				log.warn('outfit_extraction_empty_items');
				return null;
			}

			const classified = items.flatMap((item) => {
				const bounding_box = normalizeOutfitBoundingBox(item.bounding_box, dimensions.width, dimensions.height);
				if (!bounding_box) return [];
				return [{ ...item, bounding_box }];
			});

			const grounded = await this.groundItemBoxes(classified, orientedImageUrl, dimensions, signal, log);

			return {
				items: grounded,
				item_count: grounded.length,
				image_url: imageUrl,
				extracted_at: new Date().toISOString(),
				image_dimensions: dimensions
			};
		} catch (error) {
			log.error('outfit_extraction_failed', {}, error);
			return null;
		}
	}

	private async groundItemBoxes(
		items: ClothingItem[],
		imageUrl: string,
		dimensions: { width: number; height: number },
		signal: AbortSignal | undefined,
		log: Logger
	): Promise<ClothingItem[]> {
		if (!this.grounding || items.length === 0) return items;

		return Promise.all(
			items.map(async (item) => {
				for (const prompt of groundingPrompts(item)) {
					try {
						const hit = await this.grounding!.groundPhrase({
							imageUrl,
							prompt,
							imageWidth: dimensions.width,
							imageHeight: dimensions.height,
							signal,
						});
						if (!hit) continue;
						log.info('outfit_box_grounded', {
							label: item.label,
							prompt_used: hit.promptUsed,
							score: hit.score ?? null,
						});
						return { ...item, bounding_box: hit.box };
					} catch (err) {
						log.warn('outfit_box_grounding_failed', { label: item.label, prompt }, err);
					}
				}
				log.warn('outfit_box_grounding_fallback_claude', { label: item.label });
				return item;
			})
		);
	}
}

export const createOutfitExtractionService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'outfit_extraction' });
	const falKey = envBindings.FAL_KEY?.trim();
	const grounding = falKey ? new FlorenceGroundingProvider(falKey) : null;
	if (!grounding) {
		logger.warn('outfit_grounding_disabled', { reason: 'FAL_KEY is not set' });
	}
	return new OutfitExtractionService(
		createLLMService({ useCase: ModelUseCase.OUTFIT_EXTRACTION, provider: ModelProvider.CLAUDE }),
		envBindings.IMAGES,
		envBindings.OUTFIT_PHOTOS_BUCKET,
		grounding,
		logger
	);
};
