import { decodePngRgbaImage } from '../identity/encode/cropColor';
import type { BoxPad } from '../../utils/bounding_box';
import { closetTilePad } from '../../utils/bounding_box';

/** Alpha above this counts as garment (SAM apply_mask PNGs). */
export const FACE_OPAQUE_ALPHA = 32;

/** Reject near-empty mattes (boots blob / empty jacket). */
export const FACE_MIN_OPAQUE_FRAC = 0.06;

/** Reject masks that barely cut anything (full-frame opaque). */
export const FACE_MAX_OPAQUE_FRAC = 0.97;

/** Opaque pixel bbox must cover a usable share of the frame. */
export const FACE_MIN_OPAQUE_BBOX_FRAC = 0.08;

/** When Fal returns a score, require at least this (0–1 scale). */
export const FACE_MIN_MASK_SCORE = 0.45;

/**
 * Mean luma (0–255) of opaque pixels. Near-black voids (boots/cap on black) pass alpha
 * but fail this — wardrobe faces need visible fabric.
 */
export const FACE_MIN_MEAN_LUMA = 18;

/** Reject flat black / hollow outlines with no tonal variation. */
export const FACE_MIN_LUMA_STD = 10;

/** opaque_count / opaque_bbox_area — hollow edge outlines score low. */
export const FACE_MIN_FILL_DENSITY = 0.22;

export type FaceQualityMetrics = {
	width: number;
	height: number;
	opaqueFrac: number;
	opaqueBboxFrac: number;
	/** Mean luma of opaque pixels (0–255); 0 when none. */
	meanLuma: number;
	/** Population std of opaque luma; 0 when &lt;2 opaque pixels. */
	lumaStd: number;
	/** Opaque pixels / opaque bbox area (0–1). */
	fillDensity: number;
	maskScore: number | null;
};

export type FaceQualityVerdict = {
	ok: boolean;
	reason: string;
	metrics: FaceQualityMetrics;
};

/**
 * Pad for crop-then-SAM faces: start from closet tile pad, tighten footwear/accessories
 * so floor / pant cuff compete less with the garment.
 */
export function faceCutoutPad(category?: string | null): BoxPad {
	const base = closetTilePad(category);
	switch (category) {
		case 'footwear':
			return {
				...base,
				fraction: 0.12,
				min: 1.5,
				max: 6,
				sideMax: 12,
				top: 0.7,
				bottom: 1.35,
				left: 1.15,
				right: 1.15,
			};
		case 'accessory':
			return {
				...base,
				fraction: 0.14,
				max: 7,
				top: 1.4,
				bottom: 1.0,
				left: 1.1,
				right: 1.1,
			};
		default:
			return base;
	}
}

/** Categories where box-first SAM2 often grabs person/floor — prefer SAM3 label on crop. */
export function facePrefersSam3First(category?: string | null): boolean {
	return category === 'footwear' || category === 'accessory';
}

/** Near-full-frame box on a crop so SAM2 focuses on the garment, not the outfit. */
export function cropLocalBoxPx(cropW: number, cropH: number, insetFrac = 0.02): [number, number, number, number] {
	const insetX = Math.max(1, Math.round(cropW * insetFrac));
	const insetY = Math.max(1, Math.round(cropH * insetFrac));
	return [
		insetX,
		insetY,
		Math.max(insetX + 1, cropW - insetX),
		Math.max(insetY + 1, cropH - insetY),
	];
}

function emptyMetrics(width: number, height: number, maskScore: number | null): FaceQualityMetrics {
	return {
		width,
		height,
		opaqueFrac: 0,
		opaqueBboxFrac: 0,
		meanLuma: 0,
		lumaStd: 0,
		fillDensity: 0,
		maskScore,
	};
}

function luma(r: number, g: number, b: number): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function evaluateFaceRgba(
	rgba: Uint8Array,
	width: number,
	height: number,
	maskScore: number | null = null
): FaceQualityMetrics {
	const pixels = width * height;
	if (pixels <= 0 || rgba.length < pixels * 4) {
		return emptyMetrics(width, height, maskScore);
	}

	let opaque = 0;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	let lumaSum = 0;
	let lumaSumSq = 0;

	for (let i = 0; i < pixels; i++) {
		const o = i * 4;
		const a = rgba[o + 3];
		if (a < FACE_OPAQUE_ALPHA) continue;
		opaque++;
		const x = i % width;
		const y = (i / width) | 0;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
		const L = luma(rgba[o], rgba[o + 1], rgba[o + 2]);
		lumaSum += L;
		lumaSumSq += L * L;
	}

	if (opaque === 0) {
		return emptyMetrics(width, height, maskScore);
	}

	const opaqueFrac = opaque / pixels;
	const bboxArea = maxX >= minX && maxY >= minY ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
	const opaqueBboxFrac = bboxArea > 0 ? bboxArea / pixels : 0;
	const meanLuma = lumaSum / opaque;
	const variance = Math.max(0, lumaSumSq / opaque - meanLuma * meanLuma);
	const lumaStd = Math.sqrt(variance);
	const fillDensity = bboxArea > 0 ? opaque / bboxArea : 0;

	return {
		width,
		height,
		opaqueFrac,
		opaqueBboxFrac,
		meanLuma,
		lumaStd,
		fillDensity,
		maskScore,
	};
}

export async function evaluateFaceCutoutPng(
	pngBytes: Uint8Array,
	maskScore: number | null = null
): Promise<FaceQualityMetrics> {
	const copy = new ArrayBuffer(pngBytes.byteLength);
	new Uint8Array(copy).set(pngBytes);
	const { rgba, width, height } = await decodePngRgbaImage(copy);
	return evaluateFaceRgba(rgba, width, height, maskScore);
}

/** Rough ranking when both SAM2 and SAM3 fail the hard gate — prefer more visible fabric. */
export function faceQualityRank(metrics: FaceQualityMetrics): number {
	return metrics.meanLuma * metrics.opaqueFrac * Math.max(metrics.fillDensity, 0.01);
}

export function passesFaceQuality(metrics: FaceQualityMetrics): FaceQualityVerdict {
	const { opaqueFrac, opaqueBboxFrac, meanLuma, lumaStd, fillDensity, maskScore } = metrics;
	if (maskScore != null && Number.isFinite(maskScore) && maskScore < FACE_MIN_MASK_SCORE) {
		return {
			ok: false,
			reason: `mask_score ${maskScore.toFixed(3)} < ${FACE_MIN_MASK_SCORE}`,
			metrics,
		};
	}
	if (opaqueFrac < FACE_MIN_OPAQUE_FRAC) {
		return {
			ok: false,
			reason: `opaque_frac ${opaqueFrac.toFixed(3)} < ${FACE_MIN_OPAQUE_FRAC}`,
			metrics,
		};
	}
	if (opaqueFrac > FACE_MAX_OPAQUE_FRAC) {
		return {
			ok: false,
			reason: `opaque_frac ${opaqueFrac.toFixed(3)} > ${FACE_MAX_OPAQUE_FRAC}`,
			metrics,
		};
	}
	if (opaqueBboxFrac < FACE_MIN_OPAQUE_BBOX_FRAC) {
		return {
			ok: false,
			reason: `opaque_bbox_frac ${opaqueBboxFrac.toFixed(3)} < ${FACE_MIN_OPAQUE_BBOX_FRAC}`,
			metrics,
		};
	}
	if (fillDensity < FACE_MIN_FILL_DENSITY) {
		return {
			ok: false,
			reason: `fill_density ${fillDensity.toFixed(3)} < ${FACE_MIN_FILL_DENSITY}`,
			metrics,
		};
	}
	if (meanLuma < FACE_MIN_MEAN_LUMA) {
		return {
			ok: false,
			reason: `mean_luma ${meanLuma.toFixed(1)} < ${FACE_MIN_MEAN_LUMA}`,
			metrics,
		};
	}
	if (lumaStd < FACE_MIN_LUMA_STD) {
		return {
			ok: false,
			reason: `luma_std ${lumaStd.toFixed(1)} < ${FACE_MIN_LUMA_STD}`,
			metrics,
		};
	}
	return { ok: true, reason: 'ok', metrics };
}
