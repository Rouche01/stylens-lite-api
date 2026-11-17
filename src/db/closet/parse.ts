import { percentBoxIou, tileAspectRatio, closetTilePad } from '../../utils/bounding_box';
import type {
	ClosetItemExtractSnapshot,
	ClosetItemMatchWithOutfit,
	ClosetMatchProbeColor,
	ClosetMatchProbeEmbed,
	Outfit,
} from './types';
import { parseClosetMatchProbeEmbed } from './types';

export type ClosetItemMatchRow = {
	id: string;
	user_id: string;
	outfit_id: string;
	candidate_closet_item_id: string;
	bounding_box: string;
	confidence: string;
	extract_snapshot: string;
	score: number;
	cosine: number | null;
	color_distance: number | null;
	band: 'ask';
	status: 'pending' | 'same' | 'new';
	created_at: number;
	resolved_at: number | null;
	resolved_closet_item_id: string | null;
	probe_embed?: string | null;
	outfit_image_key: string;
	outfit_original_image_url: string;
};

export function parseMatchWithOutfit(row: ClosetItemMatchRow): ClosetItemMatchWithOutfit {
	return {
		id: row.id,
		user_id: row.user_id,
		outfit_id: row.outfit_id,
		candidate_closet_item_id: row.candidate_closet_item_id,
		bounding_box: parseJsonBox(row.bounding_box),
		confidence: row.confidence,
		extract_snapshot: parseExtractSnapshot(row.extract_snapshot),
		score: row.score,
		cosine: row.cosine,
		color_distance: row.color_distance,
		band: 'ask',
		status: row.status,
		created_at: row.created_at,
		resolved_at: row.resolved_at,
		resolved_closet_item_id: row.resolved_closet_item_id ?? null,
		probe_embed: parseClosetMatchProbeEmbed(row.probe_embed),
		outfit_image_key: row.outfit_image_key,
		outfit_original_image_url: row.outfit_original_image_url,
	};
}

export function parseJsonBox(raw: string): { x: number; y: number; width: number; height: number } {
	const parsed = JSON.parse(raw) as { x: number; y: number; width: number; height: number };
	return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
}

export function parseExtractSnapshot(raw: string): ClosetItemExtractSnapshot {
	const parsed = JSON.parse(raw) as Partial<ClosetItemExtractSnapshot>;
	return {
		label: String(parsed.label ?? ''),
		category: String(parsed.category ?? ''),
		subcategory: String(parsed.subcategory ?? ''),
		color: String(parsed.color ?? ''),
		pattern: String(parsed.pattern ?? ''),
		styleTags: Array.isArray(parsed.styleTags) ? parsed.styleTags.map(String) : [],
	};
}

export function mapOutfitRow(row: {
	id: string;
	user_id: string;
	original_image_url: string;
	image_key: string;
	created_at: number;
	image_width: number | null;
	image_height: number | null;
}): Outfit {
	return {
		id: row.id,
		user_id: row.user_id,
		original_image_url: row.original_image_url,
		image_key: row.image_key,
		created_at: row.created_at,
		image_width: toPositiveInt(row.image_width),
		image_height: toPositiveInt(row.image_height),
	};
}

export function closetTileAspectRatio(
	boundingBox: { x: number; y: number; width: number; height: number } | undefined,
	imageWidth: unknown,
	imageHeight: unknown,
	category?: string
): number | undefined {
	const imgW = toPositiveInt(imageWidth);
	const imgH = toPositiveInt(imageHeight);
	if (!boundingBox || imgW == null || imgH == null) return undefined;
	const ratio = tileAspectRatio(boundingBox, imgW, imgH, closetTilePad(category));
	if (ratio == null) return undefined;
	return Math.round(ratio * 10000) / 10000;
}

export function normalizeImageDimensions(
	dims?: { width: number; height: number } | null
): { width: number; height: number } | null {
	if (!dims) return null;
	const width = toPositiveInt(dims.width);
	const height = toPositiveInt(dims.height);
	if (width == null || height == null) return null;
	return { width, height };
}

export function toPositiveInt(value: unknown): number | null {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.round(n);
}

export { percentBoxIou };
