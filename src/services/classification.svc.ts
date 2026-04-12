import { LLMService, createLLMService } from './llm.svc';
import { CLASSIFICATION_SYSTEM_PROMPT } from '../llm/prompts/classification';
import { CLASSIFICATION_SCHEMA } from '../llm/schemas/classification.schema';
import { MessageEntry } from '../utils/types';
import { StyleAnalysisDB } from '../db/style_analysis';
import { StyleEntryTag } from '../db/types';

export class ClassificationService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB
	) { }

	/**
	 * A lightweight, rule-based classifier that intercepts predictable message structures
	 * to bypass the LLM and save API latency.
	 */
	private async applyHandRolledRules(message: MessageEntry, sessionId?: string): Promise<StyleEntryTag[]> {
		const tags: StyleEntryTag[] = [];

		// Rule 1: Message is pure Media with no text. Automatically classify the images as outfit references.
		if (!message.prompt || message.prompt.trim() === '') {
			const hasImages = (message.remoteImages && message.remoteImages.length > 0) || message.remoteImage;

			if (hasImages) {
				// Check session state to determine if it's the primary or alt image
				let hasPrimary = false;
				if (sessionId) {
					hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
				}

				// Multi images (modern structure)
				if (message.remoteImages && message.remoteImages.length > 0) {
					for (const img of message.remoteImages) {
						tags.push({
							tag: hasPrimary ? 'session_state:alt_outfit_image' : 'session_state:primary_outfit_image',
							payload: {
								url: img.url,
								summary: hasPrimary ? 'User uploaded an auxiliary outfit image.' : 'User uploaded the primary outfit image.',
								occasion: null, constraint: null, type: null, preference: null
							}
						});
						hasPrimary = true;
					}
				} else if (message.remoteImage) { // Single legacy image
					tags.push({
						tag: hasPrimary ? 'session_state:alt_outfit_image' : 'session_state:primary_outfit_image',
						payload: {
							url: message.remoteImage.url,
							summary: hasPrimary ? 'User uploaded an auxiliary outfit image.' : 'User uploaded the primary outfit image.',
							occasion: null, constraint: null, type: null, preference: null
						}
					});
				}
			}
		}

		// Rule 2: You could add explicit slash-command handlers here, e.g. /occasion Wedding
		// if (message.prompt?.startsWith('/')) { ... }

		return tags;
	}

	/**
	 * Classifies a message using the LLM and extracts relevant fashion context tags.
	 */
	async classifyMessage(message: MessageEntry, sessionId?: string): Promise<StyleEntryTag[]> {
		if (!message.prompt && (!message.remoteImages || message.remoteImages.length === 0) && !message.remoteImage) {
			return [];
		}

		// 1. Hand-Rolled Pipeline: Parse deterministic triggers
		const manualTags = await this.applyHandRolledRules(message, sessionId);
		if (manualTags.length > 0) {
			console.log('Skipping LLM: Hand-rolled classifier resolved tags:', manualTags);
			return manualTags;
		}

		// 2. LLM Pipeline Fallback: Parse messy natural language
		try {
			// Leverage existing logic to wait for images and sign URLs correctly
			const preparedInput = await this.llmService.prepareMessagesForLLM([message]);

			// Session State Check: Has a primary outfit already been identified?
			let stateHint = "";
			if (sessionId) {
				const hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
				stateHint = hasPrimary
					? "\n[STATE: A primary outfit has already been identified for this session. Tag any new fashion images as 'session_state:alt_outfit_image'.]"
					: "\n[STATE: No primary outfit has been identified for this session yet. If this message contains a valid outfit image, you MUST tag it as 'session_state:primary_outfit_image'.]";
			}

			const res = await this.llmService.generateResponse(
				[
					{ role: 'developer', content: CLASSIFICATION_SYSTEM_PROMPT + stateHint },
					...preparedInput
				],
				undefined,
				// Requesting JSON object for reliable parsing
				{
					type: 'json_schema',
					name: 'ClassificationResponse',
					schema: CLASSIFICATION_SCHEMA
				}
			);

			const resultText = res[0]?.text;
			if (!resultText) return [];

			const parsed = JSON.parse(resultText);
			// The LLM might return the array directly or wrapped in a 'tags' property
			const response = Array.isArray(parsed) ? parsed : (parsed.tags || []);
			console.log('Classification response:', response);
			return response;
		} catch (e) {
			console.error('Failed to classify message:', e);
			return [];
		}
	}

	/**
	 * Runs classification in the background using ctx.waitUntil to avoid blocking the main response.
	 */
	async tagEntryInBackground(entryId: string, message: MessageEntry, ctx: ExecutionContext, sessionId?: string) {
		ctx.waitUntil((async () => {
			try {
				const tags = await this.classifyMessage(message, sessionId);
				if (tags.length > 0) {
					await this.styleAnalysisDB.addEntryTags(entryId, tags);
				}
			} catch (e) {
				console.trace('Background classification failed:', e);
			}
		})());
	}
}

/**
 * Factory function to create the ClassificationService.
 */
import { ModelUseCase } from './model_config.svc';

export const createClassificationService = (database: D1Database) => {
	// Use the dedicated classification model configuration (usually a fast/cheap 'Mini' model)
	const llmService = createLLMService({ useCase: ModelUseCase.CLASSIFICATION });
	const styleAnalysisDB = new StyleAnalysisDB(database);
	return new ClassificationService(llmService, styleAnalysisDB);
};
