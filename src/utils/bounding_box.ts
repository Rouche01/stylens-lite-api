import { OutfitBoundingBox } from 'types';

export type RawBoundingBox = {
	x: number;
	y: number;
	width: number;
	height: number;
};

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
