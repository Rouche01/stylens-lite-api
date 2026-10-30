import { encodeBlurHash4x3 } from '../../../utils/blurhash';

/** Pixel color of the Florence crop — not Claude's color string. */

export type CropColorSignature = {
	h: number;
	s: number;
	l: number;
};

/**
 * Color Δ at which agree→0.
 * Calibration (Oct 2026 smokes): genuine different garments in one slot land at
 * Δ ≥ 0.35 (olive vs black, grey vs beige, hoodie vs leather); the same garment
 * under a lighting shift lands 0.02–0.17 (light jeans 0.09, navy cap 0.166).
 * The old 0.12 ramp floor-killed cos 0.996 @ Δ 0.09 to 0.435.
 */
export const COLOR_DISTANCE_FULL_PENALTY = 0.3;
/** Dark-neutral pairs use the same ramp today; kept as a hook for a wider dark band. */
export const COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL = 0.3;
const CHROMA_HUE_MIN_S = 0.12;

/**
 * Center-weighted sampling: corners/edges of a Florence box are wall, floor,
 * skin, or the neighbouring garment. Weight falls off with distance from center
 * and never drops below this floor.
 */
const COLOR_EDGE_WEIGHT_FLOOR = 0.15;
/** Footwear crops include floor under the shoe; drop this fraction of bottom rows. */
export const FOOTWEAR_COLOR_BOTTOM_CUT = 0.25;

export type ColorSampleOptions = {
	width?: number;
	height?: number;
	category?: string | null;
};

export function rgbToHsl(r: number, g: number, b: number): CropColorSignature {
	const nr = r / 255;
	const ng = g / 255;
	const nb = b / 255;
	const max = Math.max(nr, ng, nb);
	const min = Math.min(nr, ng, nb);
	const l = (max + min) / 2;
	if (max === min) {
		return { h: 0, s: 0, l };
	}
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = 0;
	if (max === nr) {
		h = (ng - nb) / d + (ng < nb ? 6 : 0);
	} else if (max === ng) {
		h = (nb - nr) / d + 2;
	} else {
		h = (nr - ng) / d + 4;
	}
	return { h: h * 60, s, l };
}

function isLikelySkin(hsl: CropColorSignature): boolean {
	return hsl.h <= 50 && hsl.s >= 0.15 && hsl.s <= 0.72 && hsl.l >= 0.12 && hsl.l <= 0.58;
}

function isLikelyBackground(hsl: CropColorSignature): boolean {
	return hsl.l > 0.62 || (hsl.s < 0.08 && hsl.l > 0.32);
}

function isNearBlack(hsl: CropColorSignature): boolean {
	return hsl.l < 0.22 && hsl.s < 0.18;
}

/**
 * Black / charcoal / navy / dark-gray (low–moderate chroma).
 * Wide enough for indoor navy caps; olive stays out via saturation.
 */
export function isDarkNeutral(hsl: CropColorSignature): boolean {
	return hsl.l < 0.38 && hsl.s < 0.28;
}

/** Pair-level dark-neutral: both dark, or mean-dark with capped chroma (lighting shift). */
export function isDarkNeutralPair(a: CropColorSignature, b: CropColorSignature): boolean {
	if (isDarkNeutral(a) && isDarkNeutral(b)) return true;
	const meanL = (a.l + b.l) / 2;
	const maxL = Math.max(a.l, b.l);
	const maxS = Math.max(a.s, b.s);
	return meanL < 0.34 && maxL < 0.42 && maxS < 0.3;
}

function isFootwearCategory(category?: string | null): boolean {
	const key = category?.trim().toLowerCase();
	return key === 'footwear' || key === 'shoes';
}

/**
 * Spatial weight for a pixel: 1 at center, {@link COLOR_EDGE_WEIGHT_FLOOR} at corners;
 * 0 for the floor band under footwear. Without dimensions every pixel weighs 1.
 */
export function colorSampleWeight(x: number, y: number, options?: ColorSampleOptions): number {
	const width = options?.width ?? 0;
	const height = options?.height ?? 0;
	if (!(width > 1) || !(height > 1)) {
		return 1;
	}
	if (isFootwearCategory(options?.category) && y >= height * (1 - FOOTWEAR_COLOR_BOTTOM_CUT)) {
		return 0;
	}
	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;
	const dx = (x - cx) / cx;
	const dy = (y - cy) / cy;
	// Normalize so the corner is 1; squared falloff keeps the inner ~60% near full weight.
	const d2 = (dx * dx + dy * dy) / 2;
	return Math.max(COLOR_EDGE_WEIGHT_FLOOR, 1 - d2);
}

export function rgbaToColorSignature(rgba: Uint8Array, options?: ColorSampleOptions): CropColorSignature {
	const width = options?.width ?? 0;
	const spatial = Boolean(options && (options.width ?? 0) > 1 && (options.height ?? 0) > 1);
	let sumL = 0;
	let sumS = 0;
	let hueX = 0;
	let hueY = 0;
	let n = 0;
	let pixel = 0;
	for (let i = 0; i + 3 < rgba.length; i += 4, pixel++) {
		if (rgba[i + 3] < 128) {
			continue;
		}
		const hsl = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2]);
		if (isLikelySkin(hsl) || isLikelyBackground(hsl)) {
			continue;
		}
		const w = spatial ? colorSampleWeight(pixel % width, Math.floor(pixel / width), options) : 1;
		if (w <= 0) {
			continue;
		}
		sumL += hsl.l * w;
		sumS += hsl.s * w;
		const weight = hsl.s * hsl.s * w;
		const rad = (hsl.h * Math.PI) / 180;
		hueX += Math.cos(rad) * weight;
		hueY += Math.sin(rad) * weight;
		n += w;
	}
	if (n <= 0) {
		return { h: 0, s: 0, l: 0 };
	}
	const h = (Math.atan2(hueY, hueX) * 180) / Math.PI;
	return {
		h: (h + 360) % 360,
		s: sumS / n,
		l: sumL / n,
	};
}

/** 0 = same color, ~0.4+ = different garment color (olive vs black). */
export function cropColorDistance(a: CropColorSignature, b: CropColorSignature): number {
	const dL = a.l - b.l;
	const dS = a.s - b.s;
	const hueWeight = Math.min(a.s, b.s) > CHROMA_HUE_MIN_S ? 1 : 0;
	let dH = Math.abs(a.h - b.h) % 360;
	if (dH > 180) {
		dH = 360 - dH;
	}
	dH = (dH / 180) * hueWeight;
	const distance = Math.hypot(dL, dS, dH);
	// Near-black vs olive/white/bright: keep hard separation.
	// Near-black vs charcoal/dark-gray (strict): lighting shift — use raw Δ only.
	// (Wider isDarkNeutral is for the agree ramp; floor skip stays conservative.)
	if (isNearBlack(a) !== isNearBlack(b)) {
		const other = isNearBlack(a) ? b : a;
		const charcoalPeer = other.l < 0.32 && other.s < 0.2;
		if (!charcoalPeer) {
			return Math.max(distance, 0.45);
		}
	}
	return distance;
}

/** Full-penalty Δ for {@link identityScore}; wider for dark-neutral pairs. */
export function identityColorFullPenalty(
	a: CropColorSignature | null | undefined,
	b: CropColorSignature | null | undefined
): number {
	if (a && b && isDarkNeutralPair(a, b)) {
		return COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL;
	}
	return COLOR_DISTANCE_FULL_PENALTY;
}

/**
 * Blend Vectorize cosine with crop-color agreement. Color mismatch cannot silent-merge.
 * @param fullPenalty - Δ at which agree→0 (default {@link COLOR_DISTANCE_FULL_PENALTY}).
 */
export function identityScore(
	cosine: number,
	colorDistance: number | null,
	fullPenalty: number = COLOR_DISTANCE_FULL_PENALTY
): number {
	if (colorDistance == null || !Number.isFinite(colorDistance)) {
		return cosine;
	}
	const penalty =
		Number.isFinite(fullPenalty) && fullPenalty > 0 ? fullPenalty : COLOR_DISTANCE_FULL_PENALTY;
	const agree = Math.max(0, 1 - colorDistance / penalty);
	return cosine * (0.25 + 0.75 * agree);
}

/** Vectorize always returns the nearest neighbor. Below this is not the same garment. */
export const IDENTITY_MATCH_MIN = 0.5;

export function isIdentityMatch(score: number): boolean {
	return Number.isFinite(score) && score >= IDENTITY_MATCH_MIN;
}

export function colorSignatureToMetadata(color: CropColorSignature): {
	color_h: number;
	color_s: number;
	color_l: number;
} {
	return {
		color_h: Math.round(color.h),
		color_s: Math.round(color.s * 100),
		color_l: Math.round(color.l * 100),
	};
}

export function colorSignatureFromMetadata(metadata?: {
	color_h?: number;
	color_s?: number;
	color_l?: number;
}): CropColorSignature | null {
	if (
		metadata?.color_h == null ||
		metadata.color_s == null ||
		metadata.color_l == null ||
		!Number.isFinite(metadata.color_h) ||
		!Number.isFinite(metadata.color_s) ||
		!Number.isFinite(metadata.color_l)
	) {
		return null;
	}
	return {
		h: metadata.color_h,
		s: metadata.color_s / 100,
		l: metadata.color_l / 100,
	};
}

export async function decodePngRgba(bytes: ArrayBuffer): Promise<Uint8Array> {
	return (await decodePngRgbaImage(bytes)).rgba;
}

export async function decodePngRgbaImage(
	bytes: ArrayBuffer
): Promise<{ rgba: Uint8Array; width: number; height: number }> {
	const png = new Uint8Array(bytes);
	if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
		throw new Error('Not a PNG');
	}
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idatParts: Uint8Array[] = [];
	while (offset + 8 <= png.length) {
		const length = readU32(png, offset);
		const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (data.length < length) {
			break;
		}
		if (type === 'IHDR') {
			width = readU32(data, 0);
			height = readU32(data, 4);
			bitDepth = data[8];
			colorType = data[9];
		} else if (type === 'IDAT') {
			idatParts.push(data);
		} else if (type === 'IEND') {
			break;
		}
		offset += 12 + length;
	}
	if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || width <= 0 || height <= 0) {
		throw new Error(`Unsupported PNG (${bitDepth}-bit type ${colorType})`);
	}
	const inflated = await inflateZlib(concatBytes(idatParts));
	return { rgba: unfilterPng(inflated, width, height, colorType === 6 ? 4 : 3), width, height };
}

export async function extractCropColorSignature(
	images: ImagesBinding,
	cropJpeg: ArrayBuffer,
	options?: { category?: string | null }
): Promise<CropColorSignature> {
	const visuals = await extractCropVisuals(images, cropJpeg, options);
	return visuals.color;
}

export async function extractCropVisuals(
	images: ImagesBinding,
	cropJpeg: ArrayBuffer,
	options?: { category?: string | null }
): Promise<{ color: CropColorSignature; blurHash: string | null }> {
	const pngResponse = (
		await images.input(new Blob([cropJpeg]).stream()).transform({ width: 32, height: 32, fit: 'cover' }).output({
			format: 'image/png',
		})
	).response();
	if (!pngResponse.ok) {
		throw new Error(`Failed to downsample crop for color (${pngResponse.status})`);
	}
	const { rgba, width, height } = await decodePngRgbaImage(await pngResponse.arrayBuffer());
	return {
		color: rgbaToColorSignature(rgba, { width, height, category: options?.category }),
		blurHash: encodeBlurHash4x3(rgba, width, height),
	};
}

function readU32(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unfilterPng(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
	const bpp = channels;
	const rowBytes = width * bpp;
	const rgba = new Uint8Array(width * height * 4);
	let src = 0;
	let prev = new Uint8Array(rowBytes);
	for (let y = 0; y < height; y++) {
		const filter = data[src++];
		const recon = new Uint8Array(rowBytes);
		for (let x = 0; x < rowBytes; x++) {
			const raw = data[src++];
			const left = x >= bpp ? recon[x - bpp] : 0;
			const up = prev[x];
			const upLeft = x >= bpp ? prev[x - bpp] : 0;
			recon[x] = (raw + paethPixel(filter, left, up, upLeft)) & 255;
		}
		for (let x = 0; x < width; x++) {
			const di = (y * width + x) * 4;
			const si = x * bpp;
			rgba[di] = recon[si];
			rgba[di + 1] = recon[si + 1];
			rgba[di + 2] = recon[si + 2];
			rgba[di + 3] = channels === 4 ? recon[si + 3] : 255;
		}
		prev = recon;
	}
	return rgba;
}

function paethPixel(filter: number, left: number, up: number, upLeft: number): number {
	if (filter === 0) {
		return 0;
	}
	if (filter === 1) {
		return left;
	}
	if (filter === 2) {
		return up;
	}
	if (filter === 3) {
		return (left + up) >> 1;
	}
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	if (pa <= pb && pa <= pc) {
		return left;
	}
	if (pb <= pc) {
		return up;
	}
	return upLeft;
}
