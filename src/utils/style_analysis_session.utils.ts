import { createLLMService } from './llm.utils';
import type { LLMMessageRole, MessageEntry } from './types';

/**
 * Sanitize LLM title output: take first line, collapse whitespace, clip length.
 * Returns null for empty/generic results.
 */
export const sanitizeTitle = (raw?: string, maxLength = 60): string | null => {
	if (!raw) return null;
	const oneLine = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
	const clipped = oneLine.slice(0, maxLength).trim();
	if (!clipped) return null;
	// Reject trivial DB fallback or clearly placeholder results
	if (/^new style analysis$/i.test(clipped)) return null;
	return clipped;
};

/**
 * Generate a concise session title from an array of MessageEntry.
 * - Returns a sanitized title string or `null` on timeout/error/no-usable-output.
 * - Options:
 *    - maxWords: hint for LLM (not strictly enforced)
 *    - maxLength: hard character limit applied in sanitization
 *    - timeoutMs: max time to wait for LLM response (ms)
 */
export async function generateTitle(
	messages: MessageEntry[],
	opts?: { maxWords?: number; maxLength?: number; timeoutMs?: number }
): Promise<string | null> {
	const { maxWords = 6, maxLength = 60, timeoutMs = 5000 } = opts || {};

	// Build a compact summary for the LLM
	const messagesSummary = messages
		.filter((m) => m.prompt || m.imageUrl)
		.map((m, i) => {
			const content = m.prompt ? m.prompt : `[image] ${m.imageUrl}`;
			return `${i + 1}. ${m.role}: ${content}`;
		})
		.join('\n');

	if (!messagesSummary) return null;

	const titlePrompt = [
		{
			role: 'user' as LLMMessageRole,
			content: `Create a concise session title (max ${maxWords} words) for a personal-stylist style analysis based on the messages below. Return only the title in Title Case.\n\n${messagesSummary}\n\nTitle:`,
		},
	];

	const llmService = createLLMService();

	// Use AbortController to cancel the underlying fetch when timeout elapses
	const controller = new AbortController();
	const signal = controller.signal;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	try {
		// Schedule abort
		timeoutId = setTimeout(() => {
			controller.abort();
		}, timeoutMs);

		// Pass the signal into the LLM call so fetch can be aborted
		const outputs = await llmService.generateResponse(titlePrompt, signal);

		// Clear timeout on success
		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}

		if (!outputs) return null;

		const candidate = Array.isArray(outputs) ? outputs.find((o: any) => o.type === 'output_text')?.text ?? null : null;
		const cleaned = sanitizeTitle(candidate ?? undefined, maxLength);
		return cleaned;
	} catch (err: any) {
		// If it was an abort, return null; otherwise log and return null
		if (err && (err.name === 'AbortError' || err.message?.includes('aborted') || err.type === 'aborted')) {
			// timeout triggered; expected path
			console.warn('generateTitle: request aborted due to timeout');
			return null;
		}
		console.warn('generateTitle error:', err);
		return null;
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}
