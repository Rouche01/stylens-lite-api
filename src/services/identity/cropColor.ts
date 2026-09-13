/** Pixel color of the Florence crop — not Claude's color string. */

export type CropColorSignature = {
	h: number;
	s: number;
	l: number;
};

const COLOR_DISTANCE_FULL_PENALTY = 0.12;
const CHROMA_HUE_MIN_S = 0.12;

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

export function rgbaToColorSignature(rgba: Uint8Array): CropColorSignature {
	let sumL = 0;
	let sumS = 0;
	let hueX = 0;
	let hueY = 0;
	let n = 0;
	for (let i = 0; i + 3 < rgba.length; i += 4) {
		if (rgba[i + 3] < 128) {
			continue;
		}
		const hsl = rgbToHsl(rgba[i], rgba[i + 1], rgba[i + 2]);
		if (isLikelySkin(hsl) || isLikelyBackground(hsl)) {
			continue;
		}
		sumL += hsl.l;
		sumS += hsl.s;
		const weight = hsl.s * hsl.s;
		const rad = (hsl.h * Math.PI) / 180;
		hueX += Math.cos(rad) * weight;
		hueY += Math.sin(rad) * weight;
		n += 1;
	}
	if (n === 0) {
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
	if (isNearBlack(a) !== isNearBlack(b)) {
		return Math.max(distance, 0.45);
	}
	return distance;
}

/** Blend Vectorize cosine with crop-color agreement. Color mismatch cannot silent-merge. */
export function identityScore(cosine: number, colorDistance: number | null): number {
	if (colorDistance == null || !Number.isFinite(colorDistance)) {
		return cosine;
	}
	const agree = Math.max(0, 1 - colorDistance / COLOR_DISTANCE_FULL_PENALTY);
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
	return unfilterPng(inflated, width, height, colorType === 6 ? 4 : 3);
}

export async function extractCropColorSignature(
	images: ImagesBinding,
	cropJpeg: ArrayBuffer
): Promise<CropColorSignature> {
	const pngResponse = (
		await images.input(new Blob([cropJpeg]).stream()).transform({ width: 32, height: 32, fit: 'cover' }).output({
			format: 'image/png',
		})
	).response();
	if (!pngResponse.ok) {
		throw new Error(`Failed to downsample crop for color (${pngResponse.status})`);
	}
	const rgba = await decodePngRgba(await pngResponse.arrayBuffer());
	return rgbaToColorSignature(rgba);
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
