import { LLMService, createLLMService } from './llm.svc';
import { StyleAnalysisDB } from '../db/style_analysis';
import { STYLE_ANALYSIS_SYSTEM_PROMPT } from '../llm/prompts/style_analysis';
import { MessageEntry } from '../utils/types';
import { ModelUseCase } from './model_config.svc';

export class StyleAnalysisService {
	constructor(
		private llmService: LLMService,
		private styleAnalysisDB: StyleAnalysisDB
	) { }

	/**
	 * Generates a streaming response for the style analysis session,
	 * injecting the persona and dynamically fetching session memory.
	 * 
	 * @param sessionId The ID of the session
	 * @param messages The sequence of messages (in chronological order, oldest first)
	 * @param onComplete Callback fired when stream finishes
	 * @param signal Optional abort signal
	 * @returns A stream representing the assistant's generation
	 */
	async generateStyleAdviceStream(
		sessionId: string,
		messages: MessageEntry[],
		onComplete?: (completeStreamText: string) => Promise<void> | void,
		signal?: AbortSignal
	): Promise<ReadableStream> {
		// 1. Fetch memory lines from DB
		const memoryLines = await this.styleAnalysisDB.getSessionMemoryLines(sessionId);

		// 2. Construct dynamic context block
		let memoryContext = '';
		if (memoryLines.length > 0) {
			memoryContext = `\n\n[SESSION MEMORY]\n${memoryLines.join('\n')}`;
		}

		// 3. Create the developer payload encapsulating the persona and current memory state
		const systemMessage: MessageEntry = {
			role: 'system',
			prompt: STYLE_ANALYSIS_SYSTEM_PROMPT + memoryContext
		};

		// 4. Prepend the system instructions before processing for LLM
		const messagesChronological = [...messages];
		messagesChronological.unshift(systemMessage);

		// 5. Structure LLM Inputs and execute stream
		const preparedMessages = await this.llmService.prepareMessagesForLLM(messagesChronological);

		return this.llmService.generateStreamingResponse(sessionId, preparedMessages, onComplete, signal);
	}
}

export const createStyleAnalysisService = (styleAnalysisDB: StyleAnalysisDB) => {
	const llmService = createLLMService({ useCase: ModelUseCase.STYLE_ANALYSIS });
	return new StyleAnalysisService(llmService, styleAnalysisDB);
};
