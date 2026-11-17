/**
 * Packshot studio backdrop — ≤2 locked swatches, contrast vs garment.
 * Dark garments → soft mint; light garments → soft charcoal (mint washes cream/white).
 */

/** Soft mint — readable behind black / navy / burgundy. */
export const PACKSHOT_BG_FOR_DARK_GARMENT = '#E8F0EE';

/** Soft charcoal — contrast for white / cream / light gray. */
export const PACKSHOT_BG_FOR_LIGHT_GARMENT = '#6B736E';

/** Mean luma at or above this (0–255 opaque) → treat garment as light. */
export const PACKSHOT_LIGHT_GARMENT_MIN_LUMA = 140;

const LIGHT_COLOR_RE =
	/\b(white|off[\s-]?white|cream|ivory|beige|tan|khaki|sand|silver|light[\s-]?gray|light[\s-]?grey|light[\s-]?blue|pale|champagne|ecru)\b/i;
const DARK_COLOR_RE =
	/\b(black|navy|dark|charcoal|espresso|brown|burgundy|oxblood|maroon|forest|olive|ink|midnight)\b/i;

export type PackshotStudioBackground = {
	hex: string;
	/** Backdrop lightness (not garment). */
	backdrop: 'light' | 'dark';
	/** Single prompt sentence for Nano Banana. */
	promptClause: string;
};

export function isLightGarmentForPackshotBg(options?: {
	color?: string | null;
	meanLuma?: number | null;
}): boolean {
	const luma = options?.meanLuma;
	if (luma != null && Number.isFinite(luma)) {
		return luma >= PACKSHOT_LIGHT_GARMENT_MIN_LUMA;
	}
	const color = (options?.color || '').trim();
	if (!color) return false;
	if (LIGHT_COLOR_RE.test(color)) return true;
	if (DARK_COLOR_RE.test(color)) return false;
	return false;
}

/**
 * Pick one of two studio swatches from extract color and/or opaque mean luma.
 * Default: dark garment → mint (most wardrobe items).
 */
export function resolvePackshotStudioBackground(options?: {
	color?: string | null;
	meanLuma?: number | null;
}): PackshotStudioBackground {
	if (isLightGarmentForPackshotBg(options)) {
		return {
			hex: PACKSHOT_BG_FOR_LIGHT_GARMENT,
			backdrop: 'dark',
			promptClause:
				'Lay the garment neatly on a solid seamless soft charcoal-gray studio backdrop (#6B736E only) — no floor/wall seam, no fabric texture, no matching-hue wash. Soft even studio lighting, slight natural shadow only.',
		};
	}
	return {
		hex: PACKSHOT_BG_FOR_DARK_GARMENT,
		backdrop: 'light',
		promptClause:
			'Lay the garment neatly on a solid seamless soft mint studio backdrop (#E8F0EE only) — no floor/wall seam, no fabric texture. Soft even studio lighting, slight natural shadow only.',
	};
}
