import { encode } from 'blurhash';

/** Component count matches Flutter `blur_hash_encoder.dart` and the session backfill script. */
export const BLURHASH_COMPONENTS_X = 4;
export const BLURHASH_COMPONENTS_Y = 3;

export function encodeBlurHash4x3(rgba: Uint8Array, width: number, height: number): string | null {
	if (width < BLURHASH_COMPONENTS_X || height < BLURHASH_COMPONENTS_Y) return null;
	if (rgba.length < width * height * 4) return null;
	try {
		return encode(new Uint8ClampedArray(rgba), width, height, BLURHASH_COMPONENTS_X, BLURHASH_COMPONENTS_Y);
	} catch {
		return null;
	}
}
