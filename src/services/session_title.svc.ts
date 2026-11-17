import { LLMService, createLLMService } from './llm.svc';
import { ModelProvider, ModelUseCase } from './model_config.svc';
import { SESSION_TITLE_SYSTEM_PROMPT, buildSessionTitleUserPrompt } from '../llm/prompts/session_title';
import { sanitizeTitle } from '../utils/style_analysis_session.utils';
import type { MessageEntry } from '../utils/types';

export class SessionTitleService {
	constructor(private llmService: LLMService) {}

	/**
	 * Generate a concise session title from conversation messages.
	 * Returns a sanitized title string or `null` on timeout/error/no-usable-output.
	 */
	async generateTitle(
		messages: MessageEntry[],
		opts?: { maxWords?: number; maxLength?: number; timeoutMs?: number },
	): Promise<string | null> {
		const { maxWords = 6, maxLength = 60, timeoutMs = 5000 } = opts || {};

		const messagesSummary = messages
			.filter((m) => m.prompt || m.remoteImage || (m.remoteImages && m.remoteImages.length > 0))
			.map((m, i) => {
				const promptPart = m.prompt ? m.prompt : '';
				const imageCount = (m.remoteImage ? 1 : 0) + (m.remoteImages?.length || 0);
				const imagePart = imageCount > 0 ? `[${imageCount} images]` : '';
				const content = `${promptPart} ${imagePart}`.trim();
				return `${i + 1}. ${m.role}: ${content}`;
			})
			.join('\n');

		if (!messagesSummary) return null;

		const titleMessages: MessageEntry[] = [
			{ role: 'system', prompt: SESSION_TITLE_SYSTEM_PROMPT },
			{ role: 'user', prompt: buildSessionTitleUserPrompt(messagesSummary, maxWords) },
		];

		const controller = new AbortController();
		const { signal } = controller;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;

		try {
			timeoutId = setTimeout(() => {
				controller.abort();
			}, timeoutMs);

			const preparedInput = await this.llmService.prepareMessagesForLLM(titleMessages);
			const outputs = await this.llmService.generateResponse(preparedInput, signal);

			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}

			if (!outputs) return null;

			const candidate = LLMService.extractText(outputs);
			return sanitizeTitle(candidate ?? undefined, maxLength);
		} catch (err: any) {
			if (err && (err.name === 'AbortError' || err.message?.includes('aborted') || err.type === 'aborted')) {
				console.warn('SessionTitleService: request aborted due to timeout');
				return null;
			}
			console.warn('SessionTitleService error:', err);
			return null;
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		}
	}
}

/**
 * Factory: dedicated TITLE_GENERATION model config (fast/cheap), Claude provider.
 */
export const createSessionTitleService = () => {
	const llmService = createLLMService({ useCase: ModelUseCase.TITLE_GENERATION, provider: ModelProvider.CLAUDE });
	return new SessionTitleService(llmService);
};
