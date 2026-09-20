/** Closet D1 types and probe/index helpers. */

/** committed → indexing → indexed | index_degraded (see identityStatus helpers). */
export type ClosetIndexStatus = 'committed' | 'indexing' | 'indexed' | 'index_degraded';

export interface ClosetItem {
	id: string;
	user_id: string;
	label: string;
	category: string;
	subcategory: string;
	color: string;
	pattern: string;
	style_tags: string[];
	created_at: number;
	updated_at: number;
	// Dynamic crop information from the best-confidence worn outfit
	original_image_url?: string;
	image_key?: string;
	bounding_box?: { x: number; y: number; width: number; height: number };
	/** Padded isolate crop aspect. Omitted when the source photo size is unknown. */
	tile_aspect_ratio?: number;
	/** 4×3 BlurHash of the latest garment crop. Omitted when not yet encoded. */
	blur_hash?: string;
	vector_id?: string | null;
	vector_indexed_at?: number | null;
	index_status?: ClosetIndexStatus | null;
	index_attempts?: number;
}

export interface Outfit {
	id: string;
	user_id: string;
	original_image_url: string;
	image_key: string;
	created_at: number;
	image_width: number | null;
	image_height: number | null;
}

export interface ClosetItemDetails extends ClosetItem {
	wear_count: number;
	wear_history: Array<{
		outfit_id: string;
		original_image_url: string;
		image_key: string;
		bounding_box: { x: number; y: number; width: number; height: number };
		confidence: string;
		worn_at: number;
		image_width: number | null;
		image_height: number | null;
	}>;
}

export type ClosetItemExtractSnapshot = {
	label: string;
	category: string;
	subcategory: string;
	color: string;
	pattern: string;
	styleTags: string[];
};

export type ClosetMatchProbeColor = {
	h: number;
	s: number;
	l: number;
};

export type ClosetMatchProbeEmbed = {
	encoder: string;
	dimensions: number;
	vector: number[];
	crop_color: ClosetMatchProbeColor | null;
	crop_blur_hash: string | null;
};

export type ClosetItemMatch = {
	id: string;
	user_id: string;
	outfit_id: string;
	candidate_closet_item_id: string;
	bounding_box: { x: number; y: number; width: number; height: number };
	confidence: string;
	extract_snapshot: ClosetItemExtractSnapshot;
	score: number;
	cosine: number | null;
	color_distance: number | null;
	band: 'ask';
	status: 'pending' | 'same' | 'new';
	created_at: number;
	resolved_at: number | null;
	resolved_closet_item_id: string | null;
	/** Null on list pending (column not selected). Hydrated on getMatchWithOutfit. */
	probe_embed: ClosetMatchProbeEmbed | null;
};

export type ClosetItemMatchWithOutfit = ClosetItemMatch & {
	outfit_image_key: string;
	outfit_original_image_url: string;
};

export type ClosetIdentityJobStatus = 'queued' | 'running' | 'done' | 'failed';

export type ClosetIdentityJobCounts = {
	queued: number;
	running: number;
	done: number;
	failed: number;
};

export type ClosetIdentityJobRow = {
	user_id: string;
	image_key: string;
	image_url: string;
	session_id: string | null;
	entry_id: string | null;
	source: string;
	status: ClosetIdentityJobStatus;
	outfit_id: string | null;
	extraction_json: string | null;
	created_at: number;
	updated_at: number;
};

export type ClosetIdentityProgressRow = {
	user_id: string;
	last_activity_at: number;
	last_started_at: number | null;
	last_settled_at: number | null;
};

/** Match columns for GET pending. Omits probe_embed (~10–20KB JSON). */
export const CLOSET_MATCH_LIST_COLUMNS = `
	m.id,
	m.user_id,
	m.outfit_id,
	m.candidate_closet_item_id,
	m.bounding_box,
	m.confidence,
	m.extract_snapshot,
	m.score,
	m.cosine,
	m.color_distance,
	m.band,
	m.status,
	m.created_at,
	m.resolved_at,
	m.resolved_closet_item_id
`;

/** Resolve path: list columns plus the cached probe blob. */
export const CLOSET_MATCH_GET_COLUMNS = `${CLOSET_MATCH_LIST_COLUMNS},
	m.probe_embed
`;

export function serializeClosetMatchProbeEmbed(probe: ClosetMatchProbeEmbed): string {
	return JSON.stringify({
		encoder: probe.encoder,
		dimensions: probe.dimensions,
		vector: probe.vector,
		crop_color: probe.crop_color,
		crop_blur_hash: probe.crop_blur_hash,
	});
}

export function parseClosetMatchProbeEmbed(raw: string | null | undefined): ClosetMatchProbeEmbed | null {
	if (raw == null || raw.trim() === '') return null;
	try {
		const parsed = JSON.parse(raw) as Partial<ClosetMatchProbeEmbed>;
		const encoder = typeof parsed.encoder === 'string' ? parsed.encoder.trim() : '';
		const dimensions = parsed.dimensions;
		if (!encoder || !Number.isInteger(dimensions) || (dimensions as number) <= 0) {
			return null;
		}
		if (!Array.isArray(parsed.vector) || parsed.vector.length !== dimensions) {
			return null;
		}
		if (!parsed.vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
			return null;
		}
		return {
			encoder,
			dimensions,
			vector: parsed.vector,
			crop_color: parseProbeColor(parsed.crop_color),
			crop_blur_hash: parseProbeBlurHash(parsed.crop_blur_hash),
		};
	} catch {
		return null;
	}
}

export function parseClosetIndexStatus(raw: string | null | undefined): ClosetIndexStatus | null {
	const value = raw?.trim();
	if (
		value === 'committed' ||
		value === 'indexing' ||
		value === 'indexed' ||
		value === 'index_degraded'
	) {
		return value;
	}
	return null;
}

export function identityJobsProcessing(counts: ClosetIdentityJobCounts): boolean {
	return counts.queued + counts.running > 0;
}

/** Client payload for GET /closet/identity/status. Failed is counted but does not keep processing on. */
export function closetIdentityStatusPayload(counts: ClosetIdentityJobCounts): {
	processing: boolean;
	queued: number;
	running: number;
	failed: number;
} {
	return {
		processing: identityJobsProcessing(counts),
		queued: counts.queued,
		running: counts.running,
		failed: counts.failed,
	};
}

export type OutfitLinkedItem = {
	closet_item_id: string;
	label: string;
	color: string;
	category: string;
	subcategory: string;
	bounding_box: { x: number; y: number; width: number; height: number };
	confidence: string;
};

function parseProbeColor(raw: ClosetMatchProbeEmbed['crop_color'] | unknown): ClosetMatchProbeColor | null {
	if (raw == null || typeof raw !== 'object') return null;
	const color = raw as Partial<ClosetMatchProbeColor>;
	if (![color.h, color.s, color.l].every((value) => typeof value === 'number' && Number.isFinite(value))) {
		return null;
	}
	return { h: color.h as number, s: color.s as number, l: color.l as number };
}

function parseProbeBlurHash(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}
