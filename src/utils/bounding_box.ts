import { OutfitBoundingBox } from 'types';

export type RawBoundingBox = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type PercentBox = RawBoundingBox;

export type ImageTrim = {
	top: number;
	left: number;
	bottom: number;
	right: number;
};

/** Percent-area floor. Tiny Florence false boxes skip Vectorize and create a new tile. */
export const IDENTITY_BOX_MIN_AREA = 2;

/** True when the crop is large enough to embed as identity. */
export function isUsableIdentityBox(box: PercentBox): boolean {
	if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) {
		return false;
	}
	return box.width * box.height >= IDENTITY_BOX_MIN_AREA;
}

/** Extra percent of the box added on each side before converting to CF Images trim. */
export type BoxPad = {
	fraction: number;
	min: number;
	max: number;
};

/** Catalog Lens crop: ~10% of the box, clamped to 1–5 percent of the frame. */
export const CATALOG_BOX_PAD: BoxPad = { fraction: 0.1, min: 1, max: 5 };

/**
 * Convert a percent xywh box to CF Images `trim` (pixels from each edge).
 * Pass {@link CATALOG_BOX_PAD} to keep Lens search padding; omit pad for a tight identity crop.
 */
export function percentBoxToTrim(box: PercentBox, imgW: number, imgH: number, pad?: BoxPad): ImageTrim {
	let paddedX = box.x;
	let paddedY = box.y;
	let paddedW = box.width;
	let paddedH = box.height;

	if (pad) {
		const padW = Math.max(pad.min, Math.min(pad.max, box.width * pad.fraction));
		const padH = Math.max(pad.min, Math.min(pad.max, box.height * pad.fraction));
		paddedX = Math.max(0, box.x - padW);
		paddedY = Math.max(0, box.y - padH);
		paddedW = Math.min(100 - paddedX, box.width + padW * 2);
		paddedH = Math.min(100 - paddedY, box.height + padH * 2);
	}

	const top = Math.round((paddedY / 100) * imgH);
	const left = Math.round((paddedX / 100) * imgW);
	const bottom = Math.max(0, Math.round(imgH - ((paddedY + paddedH) / 100) * imgH));
	const right = Math.max(0, Math.round(imgW - ((paddedX + paddedW) / 100) * imgW));

	return { top, left, bottom, right };
}

/**
 * Isolate / browse tile aspect after catalog pad (same trim as `/assets/isolate`).
 * Null when the crop would be empty or the photo size is unknown.
 */
export function tileAspectRatio(box: PercentBox, imgW: number, imgH: number, pad: BoxPad = CATALOG_BOX_PAD): number | null {
	if (!(imgW > 0) || !(imgH > 0)) return null;
	const trim = percentBoxToTrim(box, imgW, imgH, pad);
	const cropW = imgW - trim.left - trim.right;
	const cropH = imgH - trim.top - trim.bottom;
	if (cropW <= 0 || cropH <= 0) return null;
	return cropW / cropH;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Vision models mix percent (0–100) and pixel boxes, and often overflow the frame.
 * Storage / overlay contract is xywh percents of the oriented image.
 */
export function normalizeOutfitBoundingBox(
	raw: Partial<RawBoundingBox> | null | undefined,
	imageWidth: number,
	imageHeight: number
): OutfitBoundingBox | null {
	if (!raw || !isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) {
		return null;
	}
	if (imageWidth <= 0 || imageHeight <= 0) return null;

	let { x, y, width, height } = raw;
	if (width <= 0 || height <= 0) return null;

	const asPixels = x > 100 || y > 100 || width > 100 || height > 100;
	if (asPixels) {
		x = (x / imageWidth) * 100;
		y = (y / imageHeight) * 100;
		width = (width / imageWidth) * 100;
		height = (height / imageHeight) * 100;
	}

	x = Math.min(100, Math.max(0, x));
	y = Math.min(100, Math.max(0, y));
	width = Math.min(100 - x, Math.max(0.5, width));
	height = Math.min(100 - y, Math.max(0.5, height));

	return {
		x: roundBox(x),
		y: roundBox(y),
		width: roundBox(width),
		height: roundBox(height),
	};
}

function roundBox(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Intersection-over-union for percent xywh boxes. 0 if they do not overlap. */
export function percentBoxIou(a: PercentBox, b: PercentBox): number {
	const ax2 = a.x + a.width;
	const ay2 = a.y + a.height;
	const bx2 = b.x + b.width;
	const by2 = b.y + b.height;
	const overlapW = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
	const overlapH = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
	const intersection = overlapW * overlapH;
	const union = a.width * a.height + b.width * b.height - intersection;
	if (union <= 0) {
		return 0;
	}
	return intersection / union;
}
