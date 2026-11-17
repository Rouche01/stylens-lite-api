/**
 * Sanitize LLM title output: take first line, collapse whitespace, clip length.
 * Returns null for empty/generic results.
 */
export const sanitizeTitle = (raw?: string, maxLength = 60): string | null => {
	if (!raw) return null;
	let oneLine = raw.split('\n')[0].replace(/\s+/g, ' ').trim();
	// Drop wrapping quotes if the model returns them
	oneLine = oneLine.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
	// Strip machine-y product labels (prefix or suffix) — e.g. "Beach outfit Style Analysis"
	const productLabel = String.raw`(?:style|outfit|fashion)\s*analysis`;
	oneLine = oneLine
		.replace(new RegExp(`^${productLabel}\\s*[:\\-–—|]?\\s*`, 'i'), '')
		.replace(new RegExp(`\\s+${productLabel}$`, 'i'), '')
		.trim();
	const clipped = oneLine.slice(0, maxLength).trim();
	if (!clipped) return null;
	// Reject trivial DB fallback or clearly placeholder results
	if (/^(new\s+)?style\s+analysis$/i.test(clipped)) return null;
	return clipped;
};
