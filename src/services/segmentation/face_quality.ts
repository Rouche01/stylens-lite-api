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

export type FaceQualityMetrics = {
	width: number;
	height: number;
	opaqueFrac: number;
	opaqueBboxFrac: number;
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

export function evaluateFaceRgba(
	rgba: Uint8Array,
	width: number,
	height: number,
	maskScore: number | null = null
): FaceQualityMetrics {
	const pixels = width * height;
	if (pixels <= 0 || rgba.length < pixels * 4) {
		return { width, height, opaqueFrac: 0, opaqueBboxFrac: 0, maskScore };
	}

	let opaque = 0;
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;

	for (let i = 0; i < pixels; i++) {
		const a = rgba[i * 4 + 3];
		if (a < FACE_OPAQUE_ALPHA) continue;
		opaque++;
		const x = i % width;
		const y = (i / width) | 0;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}

	const opaqueFrac = opaque / pixels;
	const opaqueBboxFrac =
		maxX >= minX && maxY >= minY ? ((maxX - minX + 1) * (maxY - minY + 1)) / pixels : 0;

	return { width, height, opaqueFrac, opaqueBboxFrac, maskScore };
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

export function passesFaceQuality(metrics: FaceQualityMetrics): FaceQualityVerdict {
	const { opaqueFrac, opaqueBboxFrac, maskScore } = metrics;
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
	return { ok: true, reason: 'ok', metrics };
}
