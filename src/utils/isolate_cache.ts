/** Versioned isolate derived-object key. Bump when pixel-affecting params change. */
export const ISOLATE_CACHE_VERSION = 'v1';

export type IsolateCacheParams = {
	key: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Parsed isolate width; omit for native-size (`full`). */
	width?: number;
	cutout: boolean;
	pad: boolean;
	/** Trimmed category; only hashed when it changes the pad recipe. */
	category: string;
};

/** Stable decimal so `10` and `10.0` collide. */
export function stableIsolateNumber(n: number): string {
	if (!Number.isFinite(n)) return 'nan';
	return String(n);
}

/**
 * Canonical string of params that change isolate pixels.
 * Omits imgW/imgH (handler ignores them for trim) and enhance (unused).
 */
export function isolateCanonicalString(params: IsolateCacheParams): string {
	const width = params.width == null ? 'full' : String(params.width);
	const cutout = params.cutout ? '1' : '0';
	const pad = params.pad ? '1' : '0';
	const category = params.pad && !params.cutout ? params.category : '';
	return [
		ISOLATE_CACHE_VERSION,
		params.key,
		stableIsolateNumber(params.x),
		stableIsolateNumber(params.y),
		stableIsolateNumber(params.w),
		stableIsolateNumber(params.h),
		width,
		cutout,
		pad,
		category,
	].join('|');
}

export function isolateDerivedExtension(cutout: boolean): 'jpg' | 'png' {
	return cutout ? 'png' : 'jpg';
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	const bytes = new Uint8Array(digest);
	let hex = '';
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, '0');
	}
	return hex;
}

export async function isolateDerivedKey(params: IsolateCacheParams): Promise<string> {
	const hash = await sha256Hex(isolateCanonicalString(params));
	return `derived/isolate/${hash}.${isolateDerivedExtension(params.cutout)}`;
}

/** Reject path traversal and absolute keys (same guard as `/assets/file`). */
export function isSafeR2Key(key: string): boolean {
	return key.length > 0 && !key.includes('..') && !key.startsWith('/');
}

/** Oriented original cache key, or null when the source key is unsafe. */
export function isolateOrientedKey(sourceKey: string): string | null {
	if (!isSafeR2Key(sourceKey)) return null;
	return `derived/oriented/${sourceKey}`;
}
