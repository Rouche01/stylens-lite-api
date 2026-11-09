import { OutfitBoundingBox } from 'types';
import { normalizeOutfitBoundingBox } from 'utils/bounding_box';

export type GroundedBox = {
	x: number;
	y: number;
	width: number;
	height: number;
	score?: number;
	label?: string;
};

export type GroundingHit = {
	box: OutfitBoundingBox;
	promptUsed: string;
	score?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function boxFromObject(value: Record<string, unknown>): GroundedBox | null {
	const x = num(value.x) ?? num(value.xmin) ?? num(value.left);
	const y = num(value.y) ?? num(value.ymin) ?? num(value.top);
	const width = num(value.width) ?? num(value.w);
	const height = num(value.height) ?? num(value.h);
	const x2 = num(value.x2) ?? num(value.xmax) ?? num(value.right);
	const y2 = num(value.y2) ?? num(value.ymax) ?? num(value.bottom);
	if (x == null || y == null) return null;
	if (width != null && height != null) {
		return { x, y, width, height, score: num(value.score) ?? num(value.confidence), label: typeof value.label === 'string' ? value.label : undefined };
	}
	if (x2 != null && y2 != null) {
		return { x, y, width: x2 - x, height: y2 - y, score: num(value.score) ?? num(value.confidence) };
	}
	return null;
}

function boxFromArray(value: unknown[]): GroundedBox | null {
	if (value.length < 4) return null;
	const x = num(value[0]);
	const y = num(value[1]);
	const a = num(value[2]);
	const b = num(value[3]);
	if (x == null || y == null || a == null || b == null) return null;
	// xyxy if the third value is clearly a right/bottom edge
	if (a > x && b > y && (a > 100 || b > 100 || a + x > 100)) {
		return { x, y, width: a - x, height: b - y, score: num(value[4]) };
	}
	return { x, y, width: a, height: b, score: num(value[4]) };
}

export function collectGroundingBoxes(value: unknown, out: GroundedBox[] = [], depth = 0): GroundedBox[] {
	if (depth > 8 || value == null) return out;
	if (Array.isArray(value)) {
		if (value.length >= 4 && value.every((item) => typeof item === 'number' || item == null)) {
			const box = boxFromArray(value);
			if (box) out.push(box);
			return out;
		}
		for (const item of value) collectGroundingBoxes(item, out, depth + 1);
		return out;
	}
	if (!isRecord(value)) return out;
	const direct = boxFromObject(value);
	if (direct && direct.width > 0 && direct.height > 0) out.push(direct);
	for (const key of ['bboxes', 'boxes', 'results', 'data', 'predictions']) {
		if (key in value) collectGroundingBoxes(value[key], out, depth + 1);
	}
	return out;
}

export function boxAreaPercent(box: OutfitBoundingBox): number {
	return (box.width * box.height) / 100;
}

export function pickGroundedPercentBox(
	rawBoxes: GroundedBox[],
	imageWidth: number,
	imageHeight: number,
	maxAreaPercent = 65
): { box: OutfitBoundingBox; score?: number } | null {
	const scored: Array<{ box: OutfitBoundingBox; score: number; area: number }> = [];
	for (const raw of rawBoxes) {
		const box = normalizeOutfitBoundingBox(raw, imageWidth, imageHeight);
		if (!box) continue;
		const area = boxAreaPercent(box);
		if (area > maxAreaPercent) continue;
		scored.push({ box, score: raw.score ?? 0, area });
	}
	if (scored.length === 0) return null;
	scored.sort((a, b) => b.score - a.score || a.area - b.area);
	return { box: scored[0].box, score: scored[0].score || undefined };
}
