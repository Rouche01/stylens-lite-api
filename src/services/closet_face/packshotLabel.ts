/**
 * Type label fed into generative packshot prompts.
 * Footwear: prefer extract subcategory so a Samba crop labeled "black boots" does not
 * steer Nano Banana into inventing boots.
 */

function normalize(value?: string | null): string {
	return (value || '').trim().toLowerCase();
}

const FOOTWEAR_SUBTYPES = new Set([
	'sneakers',
	'boots',
	'loafers',
	'heels',
	'flats',
	'sandals',
	'slippers',
	'socks',
]);

/** Strip silhouette-biasing footwear words from free-text labels. */
function stripFootwearStyleWords(label: string): string {
	return label
		.replace(/\b(chelsea|combat|chukka|ankle|knee-high|knee high)\b/gi, ' ')
		.replace(/\bboots?\b/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Piece name for packshot prompts (and logging). Not a display rename of the closet item.
 */
export function packshotTypeLabel(options: {
	label: string;
	category?: string | null;
	subcategory?: string | null;
}): string {
	const label = options.label.trim() || 'garment';
	const category = normalize(options.category);
	const subcategory = normalize(options.subcategory);

	if (category !== 'footwear') {
		return label;
	}

	if (subcategory && FOOTWEAR_SUBTYPES.has(subcategory)) {
		return subcategory;
	}

	const cleaned = stripFootwearStyleWords(label);
	if (cleaned && cleaned.toLowerCase() !== 'black' && cleaned.toLowerCase() !== 'white') {
		return cleaned;
	}
	return 'shoe';
}
