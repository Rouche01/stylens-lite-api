import type { StylistOpenerMessage, StylistOpenerTag } from 'db/types';

export const STYLIST_OPENER_MAX_TEXT_LENGTH = 160;
export const ALLOWED_STYLIST_OPENER_TAGS: readonly StylistOpenerTag[] = [
	'with_image',
	'without_image',
] as const;

export type StylistOpenerInputMessage = {
	id?: string;
	text?: unknown;
	tags?: unknown;
};

export type ValidateStylistOpenersResult =
	| { ok: true; messages: StylistOpenerMessage[] }
	| { ok: false; error: string };

function isAllowedTag(tag: unknown): tag is StylistOpenerTag {
	return tag === 'with_image' || tag === 'without_image';
}

export function validateStylistOpenersBody(
	body: unknown
): ValidateStylistOpenersResult {
	if (!body || typeof body !== 'object') {
		return { ok: false, error: 'Request body must be an object' };
	}

	const messagesInput = (body as { messages?: unknown }).messages;
	if (!Array.isArray(messagesInput)) {
		return { ok: false, error: 'messages must be an array' };
	}
	if (messagesInput.length === 0) {
		return { ok: false, error: 'messages must not be empty' };
	}

	const normalized: StylistOpenerMessage[] = [];
	const seenTexts = new Set<string>();
	let hasWithImage = false;
	let hasWithoutImage = false;

	for (const [index, raw] of messagesInput.entries()) {
		const entry = raw as StylistOpenerInputMessage;
		if (!entry || typeof entry !== 'object') {
			return { ok: false, error: `messages[${index}] must be an object` };
		}

		if (typeof entry.text !== 'string') {
			return { ok: false, error: `messages[${index}].text must be a string` };
		}

		const text = entry.text.trim();
		if (!text) {
			return { ok: false, error: `messages[${index}].text must not be empty` };
		}
		if (text.length > STYLIST_OPENER_MAX_TEXT_LENGTH) {
			return {
				ok: false,
				error: `messages[${index}].text must be at most ${STYLIST_OPENER_MAX_TEXT_LENGTH} characters`,
			};
		}
		if (seenTexts.has(text)) {
			return { ok: false, error: `Duplicate message text: "${text}"` };
		}
		seenTexts.add(text);

		if (!Array.isArray(entry.tags) || entry.tags.length === 0) {
			return {
				ok: false,
				error: `messages[${index}].tags must be a non-empty array`,
			};
		}

		const tags: StylistOpenerTag[] = [];
		for (const tag of entry.tags) {
			if (!isAllowedTag(tag)) {
				return {
					ok: false,
					error: `messages[${index}].tags contains invalid tag`,
				};
			}
			if (!tags.includes(tag)) {
				tags.push(tag);
			}
		}

		if (tags.includes('with_image')) hasWithImage = true;
		if (tags.includes('without_image')) hasWithoutImage = true;

		const id =
			typeof entry.id === 'string' && entry.id.trim().length > 0
				? entry.id.trim()
				: crypto.randomUUID();

		normalized.push({ id, text, tags });
	}

	if (!hasWithImage) {
		return {
			ok: false,
			error: 'At least one message must include the with_image tag',
		};
	}
	if (!hasWithoutImage) {
		return {
			ok: false,
			error: 'At least one message must include the without_image tag',
		};
	}

	const seenIds = new Set<string>();
	for (const message of normalized) {
		if (seenIds.has(message.id)) {
			return { ok: false, error: `Duplicate message id: ${message.id}` };
		}
		seenIds.add(message.id);
	}

	return { ok: true, messages: normalized };
}
