/**
 * System prompt for short, human-readable style-analysis session titles.
 */
export const SESSION_TITLE_SYSTEM_PROMPT = `
You name styling chats with a short title, like a note someone would save for themselves.

Rules:
- Focus on the specific outfit, occasion, color, garment, or question.
- Return only the title. No quotes. No trailing punctuation.
- Prefer natural casing (not forced Title Case).
- Never include the words "Style Analysis", "Outfit Analysis", or "Fashion Analysis" — not as a prefix, suffix, or standalone title.

Good: "Evening lounge look", "Weekend trip outfits", "Beach outfit"
Bad: "Evening Lounge Style Analysis", "Weekend Trip Style Analysis", "Beach outfit Style Analysis"
`.trim();

/**
 * Thin user prompt wrapping the conversation summary for title generation.
 */
export function buildSessionTitleUserPrompt(messagesSummary: string, maxWords: number): string {
	return `Name this styling chat in ${maxWords} words or fewer.

Messages:
${messagesSummary}`;
}
