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

/** Flat brim strips (e.g. 6×3) poison crop-color; require a minimum height. */
export const IDENTITY_BOX_MIN_HEIGHT = 4;

/** Hats need a taller crop than the generic floor (brim-only boxes are ~3% tall). */
export const IDENTITY_HAT_BOX_MIN_HEIGHT = 5;

export type UsableIdentityBoxOptions = {
	category?: string | null;
	subcategory?: string | null;
};

function isHatItem(options?: UsableIdentityBoxOptions): boolean {
	const sub = options?.subcategory?.trim().toLowerCase();
	return sub === 'hat' || sub === 'cap';
}

/** Minimum percent height for identity embed (stricter for hats). */
export function identityBoxMinHeight(options?: UsableIdentityBoxOptions): number {
	return isHatItem(options) ? IDENTITY_HAT_BOX_MIN_HEIGHT : IDENTITY_BOX_MIN_HEIGHT;
}

/** True when the crop is large enough to embed as identity. */
export function isUsableIdentityBox(box: PercentBox, options?: UsableIdentityBoxOptions): boolean {
	if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) {
		return false;
	}
	if (box.width <= 0 || box.height <= 0) {
		return false;
	}
	if (box.width * box.height < IDENTITY_BOX_MIN_AREA) {
		return false;
	}
	if (box.height < identityBoxMinHeight(options)) {
		return false;
	}
	return true;
}

/** Target height (percent of frame) when a brim-only hat box is expanded to include the crown. */
export const IDENTITY_HAT_EXPAND_HEIGHT = 7;
/** Share of the vertical growth placed above the brim (crown sits above the visor). */
const HAT_EXPAND_UP_SHARE = 0.7;
/** Horizontal growth per side as a fraction of box width. */
const HAT_EXPAND_SIDE_FRACTION = 0.15;

/**
 * Box to embed for identity. Returns the Florence box when it is already usable.
 * Brim-only hat strips are center-expanded (mostly upward) so the crown is in the
 * crop instead of being skipped — a skipped hat can never be rewear-matched.
 * Null when the crop is still unusable (tiny false boxes).
 */
export function identityEmbedBox(box: PercentBox, options?: UsableIdentityBoxOptions): PercentBox | null {
	if (isUsableIdentityBox(box, options)) {
		return box;
	}
	if (!isHatItem(options)) {
		return null;
	}
	if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
		return null;
	}
	if (box.width * box.height < IDENTITY_BOX_MIN_AREA) {
		return null;
	}
	const targetHeight = Math.max(IDENTITY_HAT_EXPAND_HEIGHT, box.height);
	const grow = targetHeight - box.height;
	const side = box.width * HAT_EXPAND_SIDE_FRACTION;
	const expanded = clampPercentBox({
		x: box.x - side,
		y: box.y - grow * HAT_EXPAND_UP_SHARE,
		width: box.width + side * 2,
		height: targetHeight,
	});
	return isUsableIdentityBox(expanded, options) ? expanded : null;
}

/** Extra percent of the box added on each side before converting to CF Images trim. */
export type BoxPad = {
	fraction: number;
	min: number;
	max: number;
	/** Multipliers on the clamped pad for each side. Default 1. */
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
	/** Cap for a single side after multipliers, in percent of the frame. */
	sideMax?: number;
};

/** Catalog Lens crop: ~10% of the box, clamped to 1–5 percent of the frame. */
export const CATALOG_BOX_PAD: BoxPad = { fraction: 0.1, min: 1, max: 5 };

/** Closet browse / item-preview crop. Identity embed stays on {@link CATALOG_BOX_PAD}. */
export function closetTilePad(category?: string | null): BoxPad {
	const base: BoxPad = { fraction: 0.18, min: 2, max: 8, sideMax: 16 };
	switch (category) {
		case 'footwear':
			return { ...base, max: 10, left: 1.45, right: 1.45, top: 0.85, bottom: 2.25 };
		case 'accessory':
			return { ...base, top: 1.85, left: 1.2, right: 1.2, bottom: 1.1 };
		case 'full-body':
			return { ...base, top: 1.2, bottom: 1.35 };
		default:
			return { ...base, top: 1.12, bottom: 1.2, left: 1.12, right: 1.12 };
	}
}

/** Expand a percent box by pad (same region `/assets/isolate` trims). */
export function padPercentBox(box: PercentBox, pad: BoxPad = CATALOG_BOX_PAD): PercentBox {
	const padW = Math.max(pad.min, Math.min(pad.max, box.width * pad.fraction));
	const padH = Math.max(pad.min, Math.min(pad.max, box.height * pad.fraction));
	const cap = pad.sideMax ?? Number.POSITIVE_INFINITY;
	const left = Math.min(cap, padW * (pad.left ?? 1));
	const right = Math.min(cap, padW * (pad.right ?? 1));
	const top = Math.min(cap, padH * (pad.top ?? 1));
	const bottom = Math.min(cap, padH * (pad.bottom ?? 1));
	const x = Math.max(0, box.x - left);
	const y = Math.max(0, box.y - top);
	return {
		x,
		y,
		width: Math.min(100 - x, box.width + left + right),
		height: Math.min(100 - y, box.height + top + bottom),
	};
}

/**
 * Convert a percent xywh box to CF Images `trim` (pixels from each edge).
 * Pass {@link CATALOG_BOX_PAD} to keep Lens search padding; omit pad for a tight identity crop.
 */
export function percentBoxToTrim(box: PercentBox, imgW: number, imgH: number, pad?: BoxPad): ImageTrim {
	const region = pad ? padPercentBox(box, pad) : box;
	const top = Math.round((region.y / 100) * imgH);
	const left = Math.round((region.x / 100) * imgW);
	const bottom = Math.max(0, Math.round(imgH - ((region.y + region.height) / 100) * imgH));
	const right = Math.max(0, Math.round(imgW - ((region.x + region.width) / 100) * imgW));
	return { top, left, bottom, right };
}

/**
 * Map a photo-percent box into a crop's local percent space.
 * Null when the crop is empty or the inner box does not overlap it.
 */
export function boxInCrop(inner: PercentBox, crop: PercentBox): PercentBox | null {
	if (!(crop.width > 0) || !(crop.height > 0)) return null;
	const x = ((inner.x - crop.x) / crop.width) * 100;
	const y = ((inner.y - crop.y) / crop.height) * 100;
	const width = (inner.width / crop.width) * 100;
	const height = (inner.height / crop.height) * 100;
	const left = Math.max(0, Math.min(100, x));
	const top = Math.max(0, Math.min(100, y));
	const w = Math.max(0, Math.min(100 - left, x + width - left));
	const h = Math.max(0, Math.min(100 - top, y + height - top));
	if (w < 0.5 || h < 0.5) return null;
	return { x: left, y: top, width: w, height: h };
}

type PersonGrow = {
	up: number;
	down: number;
	side: number;
	maxUp: number;
	maxDown: number;
	maxSide: number;
	/** Max envelope span (percent of frame) unless the seed is already larger. */
	maxSpan: number;
};

function personGrow(category?: string | null): PersonGrow {
	const maxSpan = 80;
	switch (category) {
		case 'footwear':
			return { up: 4.6, down: 0.3, side: 1.2, maxUp: 58, maxDown: 8, maxSide: 18, maxSpan };
		case 'bottom':
			return { up: 1.65, down: 0.4, side: 0.35, maxUp: 42, maxDown: 14, maxSide: 14, maxSpan };
		case 'full-body':
			return { up: 0.22, down: 0.18, side: 0.14, maxUp: 12, maxDown: 12, maxSide: 10, maxSpan };
		case 'accessory':
			return { up: 2.8, down: 3.0, side: 1.8, maxUp: 32, maxDown: 36, maxSide: 20, maxSpan };
		case 'outerwear':
			return { up: 0.45, down: 1.2, side: 0.2, maxUp: 16, maxDown: 28, maxSide: 12, maxSpan };
		default:
			return { up: 0.72, down: 1.8, side: 0.4, maxUp: 18, maxDown: 34, maxSide: 14, maxSpan };
	}
}

function clampPercentBox(box: PercentBox): PercentBox {
	let { x, y, width, height } = box;
	width = Math.min(100, Math.max(0, width));
	height = Math.min(100, Math.max(0, height));
	x = Math.min(Math.max(0, x), 100 - width);
	y = Math.min(Math.max(0, y), 100 - height);
	return { x, y, width, height };
}

function unionPercentBoxes(a: PercentBox, b: PercentBox): PercentBox {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y,
	};
}

/**
 * Standing-person region inferred from a garment box. Used so item view can
 * center the wearer, not the empty wall, for every category.
 */
export function personInOutfitBox(seed: PercentBox, category?: string | null): PercentBox {
	if (!(seed.width > 0) || !(seed.height > 0)) {
		return { x: 0, y: 0, width: 100, height: 100 };
	}
	const grow = personGrow(category);
	const up = Math.min(seed.height * grow.up, grow.maxUp);
	const down = Math.min(seed.height * grow.down, grow.maxDown);
	const side = Math.min(seed.width * grow.side, grow.maxSide);
	let box = clampPercentBox({
		x: seed.x - side,
		y: seed.y - up,
		width: seed.width + side * 2,
		height: seed.height + up + down,
	});
	if (box.width > grow.maxSpan && seed.width <= grow.maxSpan) {
		const cx = box.x + box.width / 2;
		box = clampPercentBox({ x: cx - grow.maxSpan / 2, y: box.y, width: grow.maxSpan, height: box.height });
	}
	if (box.height > grow.maxSpan && seed.height <= grow.maxSpan) {
		const cy = box.y + box.height / 2;
		box = clampPercentBox({ x: box.x, y: cy - grow.maxSpan / 2, width: box.width, height: grow.maxSpan });
	}
	return unionPercentBoxes(box, seed);
}

/** Smallest native-aspect cover of a percent region, centered, then shifted into the frame. */
function coverNativeAspect(region: PercentBox, imgW: number, imgH: number): PercentBox {
	const target = imgW / imgH;
	const rx = (region.x / 100) * imgW;
	const ry = (region.y / 100) * imgH;
	const rw = Math.max(1, (region.width / 100) * imgW);
	const rh = Math.max(1, (region.height / 100) * imgH);
	const cx = rx + rw / 2;
	const cy = ry + rh / 2;

	let boxW: number;
	let boxH: number;
	if (rw / rh >= target) {
		boxW = rw;
		boxH = rw / target;
	} else {
		boxH = rh;
		boxW = rh * target;
	}

	if (boxW > imgW) {
		boxW = imgW;
		boxH = imgW / target;
	}
	if (boxH > imgH) {
		boxH = imgH;
		boxW = imgH * target;
	}

	const boxX = Math.min(Math.max(0, cx - boxW / 2), imgW - boxW);
	const boxY = Math.min(Math.max(0, cy - boxH / 2), imgH - boxH);
	return {
		x: (boxX / imgW) * 100,
		y: (boxY / imgH) * 100,
		width: (boxW / imgW) * 100,
		height: (boxH / imgH) * 100,
	};
}

/**
 * Item-view crop: native-aspect window around the person wearing the garment.
 * Centers the wearer, clips extra wall/floor, never stretches. Does not grow
 * to the photo edges.
 */
export function nativeAspectFocusWindow(
	seed: PercentBox,
	imgW: number,
	imgH: number,
	category?: string | null
): PercentBox {
	if (!(imgW > 0) || !(imgH > 0) || !(seed.width > 0) || !(seed.height > 0)) {
		return { x: 0, y: 0, width: 100, height: 100 };
	}
	return coverNativeAspect(personInOutfitBox(seed, category), imgW, imgH);
}

/**
 * Place a full-photo overlay (mask, SAM PNG) inside a crop viewport.
 * Left/top may be negative so the photo origin sits off-canvas.
 */
export function photoOverlayInCrop(crop: PercentBox): PercentBox | null {
	if (!(crop.width > 0) || !(crop.height > 0)) return null;
	return {
		x: (-crop.x / crop.width) * 100,
		y: (-crop.y / crop.height) * 100,
		width: (100 / crop.width) * 100,
		height: (100 / crop.height) * 100,
	};
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
