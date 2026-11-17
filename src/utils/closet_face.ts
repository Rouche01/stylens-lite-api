/** Closet presentation face: flatlay > cutout > crop (identity stays on crops). */

export type ClosetFaceSource = 'crop' | 'cutout' | 'flatlay';

export type ClosetFaceKeys = {
	cutout_image_key?: string | null;
	flatlay_image_key?: string | null;
	face_source?: string | null;
};

/** Prefer stored assets over the declared face_source when keys disagree. */
export function resolveClosetFaceSource(item: ClosetFaceKeys): ClosetFaceSource {
	if (item.flatlay_image_key?.trim()) return 'flatlay';
	if (item.cutout_image_key?.trim()) return 'cutout';
	return 'crop';
}

/** R2 key for the presentation face, or null when the tile should use the padded crop isolate. */
export function closetFaceImageKey(item: ClosetFaceKeys): string | null {
	const source = resolveClosetFaceSource(item);
	if (source === 'flatlay') return item.flatlay_image_key?.trim() || null;
	if (source === 'cutout') return item.cutout_image_key?.trim() || null;
	return null;
}

/** Keep face_source in sync with whichever keys are set. */
export function faceSourceFromKeys(params: {
	cutoutImageKey?: string | null;
	flatlayImageKey?: string | null;
}): ClosetFaceSource {
	return resolveClosetFaceSource({
		cutout_image_key: params.cutoutImageKey,
		flatlay_image_key: params.flatlayImageKey,
	});
}

/**
 * Trusted packshot ready for packshot-only browse (`flatlay_image_key` set).
 * Footwear may set flatlay via Nano Banana (studio-trusted cutout) or studio crop card.
 */
export function isClosetPackshotReady(item: { flatlay_image_key?: string | null }): boolean {
	return Boolean(item.flatlay_image_key?.trim());
}

/** Env / response helper — when true, list omits non-packshot tiles. */
export function isPackshotOnlyBrowseEnabled(envFlag: unknown): boolean {
	return String(envFlag || '').toLowerCase() === 'true';
}
