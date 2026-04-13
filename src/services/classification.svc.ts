import { LLMService, createLLMService } from './llm.svc';
import { CLASSIFICATION_SYSTEM_PROMPT } from '../llm/prompts/classification';
import { CLASSIFICATION_RESPONSE_FORMAT } from '../llm/schemas/classification.schema';
import { MessageEntry, RemoteImage } from '../utils/types';
import { StyleAnalysisDB } from '../db/style_analysis';
import { StyleEntryTag } from '../db/types';

export class ClassificationService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB
	) { }

	/**
	 * Extracts R2 image keys from a message, falling back to URLs if keys are unavailable.
	 */
	private extractImages(message: MessageEntry): RemoteImage[] {
		const images: RemoteImage[] = [];

		if (message.remoteImages && message.remoteImages.length > 0) {
			for (const img of message.remoteImages) {
				images.push(img);
			}
		} else if (message.remoteImage) {
			images.push(message.remoteImage);
		}

		return images;
	}

	/**
	 * A lightweight, rule-based classifier that intercepts predictable message structures
	 * to bypass the LLM and save API latency.
	 */
	private async applyHandRolledRules(message: MessageEntry, sessionId?: string, previousMessage?: MessageEntry): Promise<StyleEntryTag[]> {
		const tags: StyleEntryTag[] = [];

		// Rule 1: Message is pure Media with no text. Automatically classify the images as outfit references.
		if (!message.prompt || message.prompt.trim() === '') {
			const images = this.extractImages(message);

			if (images.length > 0) {
				let hasPrimary = false;
				if (sessionId) {
					hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
				}

				tags.push({
					tag: hasPrimary ? 'session_state:alt_outfit_image' : 'session_state:primary_outfit_image',
					payload: {
						images: images,
						summary: hasPrimary ? 'User uploaded auxiliary outfit image(s).' : 'User uploaded the primary outfit image(s).',
						occasion: null, constraint: null, type: null, preference: null
					}
				});
			}
		}

		if (previousMessage?.prompt?.includes("What's the occasion for this outfit?")) {
			tags.push({
				tag: 'session_state:occasion',
				payload: {
					occasion: message.prompt,
					summary: `This the user's response to the question "What's the occasion for this outfit?": ${message.prompt}`,
					constraint: null, type: null, preference: null
				}
			})
		}

		// Rule 2: You could add explicit slash-command handlers here, e.g. /occasion Wedding
		// if (message.prompt?.startsWith('/')) { ... }

		return tags;
	}

	/**
	 * Classifies a message using the LLM and extracts relevant fashion context tags.
	 */
	async classifyMessage(message: MessageEntry, sessionId?: string, previousMessage?: MessageEntry): Promise<StyleEntryTag[]> {
		if (!message.prompt && (!message.remoteImages || message.remoteImages.length === 0) && !message.remoteImage) {
			return [];
		}

		// 1. Hand-Rolled Pipeline: Parse deterministic triggers
		const manualTags = await this.applyHandRolledRules(message, sessionId, previousMessage);
		if (manualTags.length > 0) {
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
				CLASSIFICATION_RESPONSE_FORMAT
			);

			const resultText = res[0]?.text;
			if (!resultText) return [];

			const parsed = JSON.parse(resultText);
			// The LLM might return the array directly or wrapped in a 'tags' property
			const response: StyleEntryTag[] = Array.isArray(parsed) ? parsed : (parsed.tags || []);

			// Post-process: Inject images and enforce primary/alt correctness.
			// The LLM can't see R2 keys and unreliably follows state hints, so we fix both deterministically.
			const images = this.extractImages(message);
			let hasPrimary = false;
			if (sessionId) {
				hasPrimary = await this.styleAnalysisDB.hasPrimaryOutfitTag(sessionId);
			}

			for (const tag of response) {
				if (tag.tag === 'session_state:primary_outfit_image' || tag.tag === 'session_state:alt_outfit_image') {
					// Force correct tag based on actual DB state
					if (hasPrimary) {
						tag.tag = 'session_state:alt_outfit_image';
					}

					// Inject actual images from the original message
					if (images.length > 0) {
						tag.payload = { ...tag.payload, images };
					}
				}
			}

			return response;
		} catch (e) {
			console.error('Failed to classify message:', e);
			return [];
		}
	}

	/**
	 * Runs classification in the background using ctx.waitUntil to avoid blocking the main response.
	 * @param previousMessage - Pass the previous message for context. Pass `null` to explicitly indicate
	 *   no previous message exists. Pass `undefined` (or omit) to resolve from DB automatically.
	 */
	async tagEntryInBackground(entryId: string, message: MessageEntry, ctx: ExecutionContext, sessionId?: string, previousMessage?: MessageEntry | null) {
		ctx.waitUntil((async () => {
			try {
				// null = caller knows there's no previous message, undefined = resolve from DB
				let prevMsg: MessageEntry | undefined = previousMessage ?? undefined;
				if (previousMessage === undefined && sessionId) {
					const { messages: recent } = await this.styleAnalysisDB.getSessionMessages(sessionId, { page: 1, pageSize: 2 });
					const prevEntry = recent.length > 1 ? recent[1] : undefined;
					if (prevEntry) {
						prevMsg = {
							role: prevEntry.role as 'user' | 'assistant' | 'system',
							prompt: prevEntry.content || undefined
						};
					}
				}

				const tags = await this.classifyMessage(message, sessionId, prevMsg);
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
