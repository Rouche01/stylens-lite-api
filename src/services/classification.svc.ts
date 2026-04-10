import { LLMService, createLLMService } from './llm.svc';
import { CLASSIFICATION_SYSTEM_PROMPT } from './prompts/classification';
import { MessageEntry } from '../utils/types';
import { StyleAnalysisDB } from '../db/style_analysis';
import { StyleEntryTag } from '../db/types';

export class ClassificationService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB
	) { }

	/**
	 * Classifies a message using the LLM and extracts relevant fashion context tags.
	 */
	async classifyMessage(message: MessageEntry, sessionId?: string): Promise<StyleEntryTag[]> {
		if (!message.prompt && (!message.remoteImages || message.remoteImages.length === 0) && !message.remoteImage) {
			return [];
		}

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
					type: 'json_object',
					name: 'ClassificationResponse',
					schema: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								tag: { type: 'string' },
								payload: { type: 'object', additionalProperties: true }
							},
							required: ['tag']
						}
					}
				}
			);

			const resultText = res[0]?.text;
			if (!resultText) return [];

			const parsed = JSON.parse(resultText);
			// The LLM might return the array directly or wrapped in a 'tags' property
			return Array.isArray(parsed) ? parsed : (parsed.tags || []);
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
export const createClassificationService = (database: D1Database) => {
	// We use the default LLMService which is configured with the 'Mini' model for cost efficiency
	const llmService = createLLMService();
	const styleAnalysisDB = new StyleAnalysisDB(database);
	return new ClassificationService(llmService, styleAnalysisDB);
};
