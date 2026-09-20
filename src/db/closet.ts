

import { percentBoxIou, tileAspectRatio, closetTilePad } from '../utils/bounding_box';

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

export class ClosetDB {
	constructor(private db: D1Database) { }

	/**
	 * Creates a new Outfit record representing the raw uploaded photo.
	 */
	async createOutfit(
		userId: string,
		imageUrl: string,
		imageKey: string,
		imageDimensions?: { width: number; height: number }
	): Promise<Outfit> {
		const id = crypto.randomUUID();
		const now = Date.now();
		const dims = normalizeImageDimensions(imageDimensions);

		await this.db
			.prepare(
				`
				INSERT INTO outfits (id, user_id, original_image_url, image_key, created_at, image_width, image_height)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				`
			)
			.bind(id, userId, imageUrl, imageKey, now, dims?.width ?? null, dims?.height ?? null)
			.run();

		return {
			id,
			user_id: userId,
			original_image_url: imageUrl,
			image_key: imageKey,
			created_at: now,
			image_width: dims?.width ?? null,
			image_height: dims?.height ?? null,
		};
	}

	async getOutfitByUserImageKey(userId: string, imageKey: string): Promise<Outfit | null> {
		const row = await this.db
			.prepare(
				`
				SELECT id, user_id, original_image_url, image_key, created_at, image_width, image_height
				FROM outfits
				WHERE user_id = ? AND image_key = ?
				ORDER BY created_at ASC
				LIMIT 1
				`
			)
			.bind(userId, imageKey)
			.first<{
				id: string;
				user_id: string;
				original_image_url: string;
				image_key: string;
				created_at: number;
				image_width: number | null;
				image_height: number | null;
			}>();
		return row ? mapOutfitRow(row) : null;
	}

	async setOutfitImageDimensionsIfMissing(
		outfitId: string,
		width: number,
		height: number
	): Promise<void> {
		const dims = normalizeImageDimensions({ width, height });
		if (!dims) return;

		await this.db
			.prepare(
				`
				UPDATE outfits
				SET image_width = ?, image_height = ?
				WHERE id = ? AND image_width IS NULL AND image_height IS NULL
				`
			)
			.bind(dims.width, dims.height, outfitId)
			.run();
	}

	/**
	 * Creates a new persistent closet item.
	 */
	async createClosetItem(params: {
		id?: string;
		userId: string;
		label: string;
		category: string;
		subcategory: string;
		color: string;
		pattern: string;
		styleTags: string[];
	}): Promise<ClosetItem> {
		const id = params.id?.trim() || crypto.randomUUID();
		const now = Date.now();
		const styleTagsJson = JSON.stringify(params.styleTags);

		await this.db
			.prepare(
				`
				INSERT INTO closet_items (id, user_id, label, category, subcategory, color, pattern, style_tags, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`
			)
			.bind(id, params.userId, params.label, params.category, params.subcategory, params.color, params.pattern, styleTagsJson, now, now)
			.run();

		return {
			id,
			user_id: params.userId,
			label: params.label,
			category: params.category,
			subcategory: params.subcategory,
			color: params.color,
			pattern: params.pattern,
			style_tags: params.styleTags,
			created_at: now,
			updated_at: now
		};
	}

	/**
	 * Links a closet item to an outfit with bounding box coordinates.
	 */
	async linkClosetItemToOutfit(params: {
		outfitId: string;
		closetItemId: string;
		boundingBox: { x: number; y: number; width: number; height: number };
		confidence: 'high' | 'medium' | 'low';
		blurHash?: string | null;
	}): Promise<void> {
		const id = crypto.randomUUID();
		const now = Date.now();
		const boundingBoxJson = JSON.stringify(params.boundingBox);
		const blurHash = params.blurHash?.trim() || null;

		await this.db
			.prepare(
				`
				INSERT INTO outfit_clothing_items (id, outfit_id, closet_item_id, bounding_box, confidence, blur_hash, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				`
			)
			.bind(id, params.outfitId, params.closetItemId, boundingBoxJson, params.confidence, blurHash, now)
			.run();
	}

	async getLatestItemBlurHash(closetItemId: string): Promise<string | null> {
		const row = await this.db
			.prepare(
				`
				SELECT blur_hash
				FROM outfit_clothing_items
				WHERE closet_item_id = ? AND blur_hash IS NOT NULL AND length(blur_hash) > 0
				ORDER BY created_at DESC
				LIMIT 1
				`
			)
			.bind(closetItemId)
			.first<{ blur_hash: string }>();
		return row?.blur_hash?.trim() || null;
	}

	/**
	 * Retrieves the user's closet catalog with dynamic edge-isolated crop parameters.
	 */
	async getClosetItems(userId: string): Promise<ClosetItem[]> {
		const result = await this.db
			.prepare(
				`
				SELECT 
					ci.*,
					oci.bounding_box,
					oci.confidence,
					o.original_image_url,
					o.image_key,
					o.image_width,
					o.image_height,
					oci.blur_hash
				FROM closet_items ci
				LEFT JOIN (
					-- Subquery to select the most recent link for each closet item
					SELECT closet_item_id, outfit_id, bounding_box, confidence, blur_hash, MAX(created_at) as max_created
					FROM outfit_clothing_items
					GROUP BY closet_item_id
				) oci ON ci.id = oci.closet_item_id
				LEFT JOIN outfits o ON oci.outfit_id = o.id
				WHERE ci.user_id = ?
				ORDER BY ci.created_at DESC
				`
			)
			.bind(userId)
			.all<any>();

		return (result.results || []).map((row: any) => {
			const item: ClosetItem = {
				id: row.id,
				user_id: row.user_id,
				label: row.label,
				category: row.category,
				subcategory: row.subcategory,
				color: row.color,
				pattern: row.pattern,
				style_tags: row.style_tags ? JSON.parse(row.style_tags) : [],
				created_at: row.created_at,
				updated_at: row.updated_at
			};

			if (row.original_image_url) {
				item.original_image_url = row.original_image_url;
				item.image_key = row.image_key;
				item.bounding_box = row.bounding_box ? JSON.parse(row.bounding_box) : undefined;
				const ratio = closetTileAspectRatio(
					item.bounding_box,
					row.image_width,
					row.image_height,
					item.category
				);
				if (ratio != null) {
					item.tile_aspect_ratio = ratio;
				}
				const blurHash = typeof row.blur_hash === 'string' ? row.blur_hash.trim() : '';
				if (blurHash) {
					item.blur_hash = blurHash;
				}
			}

			return item;
		});
	}

	/**
	 * Admin lookup: closet item by id, any user.
	 */
	async getClosetItemDetailsById(itemId: string): Promise<ClosetItemDetails | null> {
		const itemRow = await this.db
			.prepare(`SELECT * FROM closet_items WHERE id = ?`)
			.bind(itemId)
			.first<any>();

		if (!itemRow) return null;

		// 2. Fetch wear count
		const countResult = await this.db
			.prepare(`SELECT COUNT(*) as total FROM outfit_clothing_items WHERE closet_item_id = ?`)
			.bind(itemId)
			.first<any>();
		const wearCount = countResult ? countResult.total : 0;

		// 3. Fetch wear history
		const historyRows = await this.db
			.prepare(
				`
				SELECT o.id as outfit_id, o.original_image_url, o.image_key, o.image_width, o.image_height, oci.bounding_box, oci.confidence, oci.created_at as worn_at
				FROM outfit_clothing_items oci
				JOIN outfits o ON oci.outfit_id = o.id
				WHERE oci.closet_item_id = ?
				ORDER BY oci.created_at DESC
				`
			)
			.bind(itemId)
			.all<any>();

		const wearHistory = (historyRows.results || []).map((row: any) => ({
			outfit_id: row.outfit_id,
			original_image_url: row.original_image_url,
			image_key: row.image_key,
			bounding_box: JSON.parse(row.bounding_box),
			confidence: row.confidence,
			worn_at: row.worn_at,
			image_width: row.image_width == null ? null : Number(row.image_width),
			image_height: row.image_height == null ? null : Number(row.image_height),
		}));

		// Use the first wear history item as the primary dynamic cover
		const latestWear = wearHistory[0];

		return {
			id: itemRow.id,
			user_id: itemRow.user_id,
			label: itemRow.label,
			category: itemRow.category,
			subcategory: itemRow.subcategory,
			color: itemRow.color,
			pattern: itemRow.pattern,
			style_tags: itemRow.style_tags ? JSON.parse(itemRow.style_tags) : [],
			created_at: itemRow.created_at,
			updated_at: itemRow.updated_at,
			original_image_url: latestWear?.original_image_url,
			image_key: latestWear?.image_key,
			bounding_box: latestWear?.bounding_box,
			wear_count: wearCount,
			wear_history: wearHistory
		};
	}

	/**
	 * Retrieves detailed history and statistics for a specific closet item.
	 */
	async getClosetItemDetails(userId: string, itemId: string): Promise<ClosetItemDetails | null> {
		const details = await this.getClosetItemDetailsById(itemId);
		if (!details || details.user_id !== userId) return null;
		return details;
	}

	/**
	 * All extracted pieces on one outfit photo (for bbox overlay).
	 */
	async getOutfitLinkedItems(outfitId: string): Promise<OutfitLinkedItem[]> {
		const result = await this.db
			.prepare(
				`
				SELECT
					ci.id as closet_item_id,
					ci.label,
					ci.color,
					ci.category,
					ci.subcategory,
					oci.bounding_box,
					oci.confidence
				FROM outfit_clothing_items oci
				JOIN closet_items ci ON ci.id = oci.closet_item_id
				WHERE oci.outfit_id = ?
				ORDER BY oci.created_at ASC
				`
			)
			.bind(outfitId)
			.all<any>();

		return (result.results || []).map((row: any) => ({
			closet_item_id: row.closet_item_id,
			label: row.label,
			color: row.color,
			category: row.category,
			subcategory: row.subcategory,
			bounding_box: JSON.parse(row.bounding_box),
			confidence: row.confidence
		}));
	}

	async getClosetItemSummary(itemId: string): Promise<{ id: string; label: string; category: string } | null> {
		const row = await this.db
			.prepare(`SELECT id, label, category FROM closet_items WHERE id = ?`)
			.bind(itemId)
			.first<{ id: string; label: string; category: string }>();
		return row ?? null;
	}

	/**
	 * One create-commit writer per user. Stale rows (crashed workers) are stolen.
	 */
	async tryAcquireIdentityLock(userId: string, jobId: string, staleMs = 10 * 60 * 1000): Promise<boolean> {
		const now = Date.now();
		await this.db
			.prepare(`DELETE FROM identity_inflight WHERE user_id = ? AND created_at < ?`)
			.bind(userId, now - staleMs)
			.run();
		try {
			await this.db
				.prepare(
					`
					INSERT INTO identity_inflight (user_id, job_id, created_at)
					VALUES (?, ?, ?)
					`
				)
				.bind(userId, jobId, now)
				.run();
			return true;
		} catch {
			return false;
		}
	}

	async releaseIdentityLock(userId: string, jobId: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM identity_inflight WHERE user_id = ? AND job_id = ?`)
			.bind(userId, jobId)
			.run();
	}

	async tryInsertIdentityJob(params: {
		userId: string;
		imageKey: string;
		imageUrl: string;
		sessionId?: string;
		entryId?: string;
		source?: string;
	}): Promise<boolean> {
		const now = Date.now();
		const result = await this.db
			.prepare(
				`
				INSERT OR IGNORE INTO closet_identity_jobs (
					user_id, image_key, image_url, session_id, entry_id, source, status, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
				`
			)
			.bind(
				params.userId,
				params.imageKey,
				params.imageUrl,
				params.sessionId ?? null,
				params.entryId ?? null,
				params.source ?? 'session',
				now,
				now
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async getIdentityJob(userId: string, imageKey: string): Promise<ClosetIdentityJobRow | null> {
		const row = await this.db
			.prepare(
				`
				SELECT user_id, image_key, image_url, session_id, entry_id, source, status, outfit_id, extraction_json, created_at, updated_at
				FROM closet_identity_jobs
				WHERE user_id = ? AND image_key = ?
				`
			)
			.bind(userId, imageKey)
			.first<ClosetIdentityJobRow>();
		return row ?? null;
	}

	async saveIdentityJobExtraction(userId: string, imageKey: string, extractionJson: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`
				UPDATE closet_identity_jobs
				SET extraction_json = ?, updated_at = ?
				WHERE user_id = ? AND image_key = ?
				`
			)
			.bind(extractionJson, now, userId, imageKey)
			.run();
	}

	async markIdentityJobDone(userId: string, imageKey: string, outfitId: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`
				UPDATE closet_identity_jobs
				SET status = 'done', outfit_id = ?, updated_at = ?
				WHERE user_id = ? AND image_key = ?
				`
			)
			.bind(outfitId, now, userId, imageKey)
			.run();
	}

	/** Set queued/running/failed. Does not move a done job, and does not set done (use markIdentityJobDone). */
	async markIdentityJobStatus(
		userId: string,
		imageKey: string,
		status: Exclude<ClosetIdentityJobStatus, 'done'>
	): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`
				UPDATE closet_identity_jobs
				SET status = ?, updated_at = ?
				WHERE user_id = ? AND image_key = ? AND status != 'done'
				`
			)
			.bind(status, now, userId, imageKey)
			.run();
	}

	async countIdentityJobsByStatus(userId: string): Promise<ClosetIdentityJobCounts> {
		const result = await this.db
			.prepare(
				`
				SELECT status, COUNT(*) as total
				FROM closet_identity_jobs
				WHERE user_id = ?
				GROUP BY status
				`
			)
			.bind(userId)
			.all<{ status: string; total: number }>();

		const counts: ClosetIdentityJobCounts = { queued: 0, running: 0, done: 0, failed: 0 };
		for (const row of result.results ?? []) {
			if (row.status === 'queued' || row.status === 'running' || row.status === 'done' || row.status === 'failed') {
				counts[row.status] = Number(row.total) || 0;
			}
		}
		return counts;
	}

	async touchIdentityProgressActivity(userId: string, atMs = Date.now()): Promise<void> {
		await this.db
			.prepare(
				`
				INSERT INTO closet_identity_progress (user_id, last_activity_at, last_started_at, last_settled_at)
				VALUES (?, ?, NULL, NULL)
				ON CONFLICT(user_id) DO UPDATE SET last_activity_at = excluded.last_activity_at
				`
			)
			.bind(userId, atMs)
			.run();
	}

	async getIdentityProgressState(userId: string): Promise<ClosetIdentityProgressRow | null> {
		const row = await this.db
			.prepare(
				`
				SELECT user_id, last_activity_at, last_started_at, last_settled_at
				FROM closet_identity_progress
				WHERE user_id = ?
				`
			)
			.bind(userId)
			.first<ClosetIdentityProgressRow>();
		return row ?? null;
	}

	async markIdentityProgressStarted(userId: string, atMs = Date.now()): Promise<void> {
		const result = await this.db
			.prepare(`UPDATE closet_identity_progress SET last_started_at = ? WHERE user_id = ?`)
			.bind(atMs, userId)
			.run();
		if ((result.meta.changes ?? 0) > 0) return;
		await this.db
			.prepare(
				`
				INSERT INTO closet_identity_progress (user_id, last_activity_at, last_started_at, last_settled_at)
				VALUES (?, ?, ?, NULL)
				`
			)
			.bind(userId, atMs, atMs)
			.run();
	}

	async markIdentityProgressSettled(userId: string, atMs = Date.now()): Promise<void> {
		const result = await this.db
			.prepare(`UPDATE closet_identity_progress SET last_settled_at = ? WHERE user_id = ?`)
			.bind(atMs, userId)
			.run();
		if ((result.meta.changes ?? 0) > 0) return;
		await this.db
			.prepare(
				`
				INSERT INTO closet_identity_progress (user_id, last_activity_at, last_started_at, last_settled_at)
				VALUES (?, ?, NULL, ?)
				`
			)
			.bind(userId, atMs, atMs)
			.run();
	}

	/**
	 * Closet item on this outfit photo whose stored box overlaps the crop (highest IoU).
	 */
	async findClosetItemForPhotoCrop(
		userId: string,
		imageKey: string,
		boundingBox: { x: number; y: number; width: number; height: number }
	): Promise<{ id: string; label: string; category: string; iou: number } | null> {
		const result = await this.db
			.prepare(
				`
				SELECT ci.id, ci.label, ci.category, oci.bounding_box
				FROM outfits o
				INNER JOIN outfit_clothing_items oci ON oci.outfit_id = o.id
				INNER JOIN closet_items ci ON ci.id = oci.closet_item_id
				WHERE o.user_id = ? AND o.image_key = ?
				`
			)
			.bind(userId, imageKey)
			.all<{ id: string; label: string; category: string; bounding_box: string }>();

		const minIou = 0.3;
		let best: { id: string; label: string; category: string; iou: number } | null = null;
		for (const row of result.results || []) {
			let stored: { x: number; y: number; width: number; height: number };
			try {
				stored = JSON.parse(row.bounding_box);
			} catch {
				continue;
			}
			if (
				typeof stored?.x !== 'number' ||
				typeof stored?.y !== 'number' ||
				typeof stored?.width !== 'number' ||
				typeof stored?.height !== 'number'
			) {
				continue;
			}
			const iou = percentBoxIou(boundingBox, stored);
			if (iou < minIou) {
				continue;
			}
			if (!best || iou > best.iou) {
				best = { id: row.id, label: row.label, category: row.category, iou };
			}
		}
		return best;
	}

	/**
	 * Persist a close-match ask. Does not create a closet tile or wear row.
	 */
	async createPendingMatch(params: {
		userId: string;
		outfitId: string;
		candidateClosetItemId: string;
		boundingBox: { x: number; y: number; width: number; height: number };
		confidence: 'high' | 'medium' | 'low';
		extractSnapshot: ClosetItemExtractSnapshot;
		score: number;
		cosine?: number | null;
		colorDistance?: number | null;
	}): Promise<ClosetItemMatch> {
		const id = crypto.randomUUID();
		const now = Date.now();
		const boundingBoxJson = JSON.stringify(params.boundingBox);
		const snapshotJson = JSON.stringify(params.extractSnapshot);
		const cosine = params.cosine ?? null;
		const colorDistance = params.colorDistance ?? null;

		await this.db
			.prepare(
				`
				INSERT INTO closet_item_matches (
					id, user_id, outfit_id, candidate_closet_item_id, bounding_box, confidence,
					extract_snapshot, score, cosine, color_distance, band, status, created_at, resolved_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ask', 'pending', ?, NULL)
				`
			)
			.bind(
				id,
				params.userId,
				params.outfitId,
				params.candidateClosetItemId,
				boundingBoxJson,
				params.confidence,
				snapshotJson,
				params.score,
				cosine,
				colorDistance,
				now
			)
			.run();

		return {
			id,
			user_id: params.userId,
			outfit_id: params.outfitId,
			candidate_closet_item_id: params.candidateClosetItemId,
			bounding_box: params.boundingBox,
			confidence: params.confidence,
			extract_snapshot: params.extractSnapshot,
			score: params.score,
			cosine,
			color_distance: colorDistance,
			band: 'ask',
			status: 'pending',
			created_at: now,
			resolved_at: null,
			resolved_closet_item_id: null,
			probe_embed: null,
		};
	}

	async listPendingMatches(userId: string): Promise<ClosetItemMatchWithOutfit[]> {
		const result = await this.db
			.prepare(
				`
				SELECT
					${CLOSET_MATCH_LIST_COLUMNS},
					o.image_key as outfit_image_key,
					o.original_image_url as outfit_original_image_url
				FROM closet_item_matches m
				INNER JOIN outfits o ON o.id = m.outfit_id
				WHERE m.user_id = ? AND m.status = 'pending'
				ORDER BY m.created_at DESC
				`
			)
			.bind(userId)
			.all<ClosetItemMatchRow>();

		return (result.results || []).map(parseMatchWithOutfit);
	}

	async getMatchWithOutfit(userId: string, matchId: string): Promise<ClosetItemMatchWithOutfit | null> {
		const row = await this.db
			.prepare(
				`
				SELECT
					${CLOSET_MATCH_GET_COLUMNS},
					o.image_key as outfit_image_key,
					o.original_image_url as outfit_original_image_url
				FROM closet_item_matches m
				INNER JOIN outfits o ON o.id = m.outfit_id
				WHERE m.id = ? AND m.user_id = ?
				`
			)
			.bind(matchId, userId)
			.first<ClosetItemMatchRow>();

		return row ? parseMatchWithOutfit(row) : null;
	}

	async markMatchResolved(
		userId: string,
		matchId: string,
		status: 'same' | 'new'
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				`
				UPDATE closet_item_matches
				SET status = ?, resolved_at = ?
				WHERE id = ? AND user_id = ? AND status = 'pending'
				`
			)
			.bind(status, Date.now(), matchId, userId)
			.run();

		return (result.meta.changes ?? 0) > 0;
	}

	async updatePendingMatch(
		userId: string,
		matchId: string,
		params: {
			candidateClosetItemId: string;
			score: number;
			cosine?: number | null;
			colorDistance?: number | null;
		}
	): Promise<boolean> {
		const result = await this.db
			.prepare(
				`
				UPDATE closet_item_matches
				SET candidate_closet_item_id = ?, score = ?, cosine = ?, color_distance = ?
				WHERE id = ? AND user_id = ? AND status = 'pending'
				`
			)
			.bind(
				params.candidateClosetItemId,
				params.score,
				params.cosine ?? null,
				params.colorDistance ?? null,
				matchId,
				userId
			)
			.run();

		return (result.meta.changes ?? 0) > 0;
	}

	async countPendingMatches(userId: string): Promise<number> {
		const row = await this.db
			.prepare(`SELECT COUNT(*) as total FROM closet_item_matches WHERE user_id = ? AND status = 'pending'`)
			.bind(userId)
			.first<{ total: number }>();
		return row?.total ?? 0;
	}

	async touchMatchAsk(userId: string, atMs = Date.now()): Promise<void> {
		await this.db
			.prepare(
				`
				INSERT INTO closet_match_notify (user_id, last_ask_at, last_notified_at)
				VALUES (?, ?, NULL)
				ON CONFLICT(user_id) DO UPDATE SET last_ask_at = excluded.last_ask_at
				`
			)
			.bind(userId, atMs)
			.run();
	}

	async getMatchNotifyState(
		userId: string
	): Promise<{ last_ask_at: number; last_notified_at: number | null } | null> {
		const row = await this.db
			.prepare(`SELECT last_ask_at, last_notified_at FROM closet_match_notify WHERE user_id = ?`)
			.bind(userId)
			.first<{ last_ask_at: number; last_notified_at: number | null }>();
		return row ?? null;
	}

	async markMatchNotified(userId: string, atMs = Date.now()): Promise<void> {
		const result = await this.db
			.prepare(`UPDATE closet_match_notify SET last_notified_at = ? WHERE user_id = ?`)
			.bind(atMs, userId)
			.run();
		if ((result.meta.changes ?? 0) > 0) return;
		await this.db
			.prepare(
				`
				INSERT INTO closet_match_notify (user_id, last_ask_at, last_notified_at)
				VALUES (?, ?, ?)
				`
			)
			.bind(userId, atMs, atMs)
			.run();
	}

	/**
	 * Deletes a closet item completely from the catalog.
	 */
	async deleteClosetItem(userId: string, itemId: string): Promise<boolean> {
		const result = await this.db
			.prepare(`DELETE FROM closet_items WHERE id = ? AND user_id = ?`)
			.bind(itemId, userId)
			.run();

		return result.success;
	}
}

type ClosetItemMatchRow = {
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

function parseMatchWithOutfit(row: ClosetItemMatchRow): ClosetItemMatchWithOutfit {
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

function parseJsonBox(raw: string): { x: number; y: number; width: number; height: number } {
	const parsed = JSON.parse(raw) as { x: number; y: number; width: number; height: number };
	return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
}

function parseExtractSnapshot(raw: string): ClosetItemExtractSnapshot {
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

function mapOutfitRow(row: {
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

function closetTileAspectRatio(
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

function normalizeImageDimensions(
	dims?: { width: number; height: number } | null
): { width: number; height: number } | null {
	if (!dims) return null;
	const width = toPositiveInt(dims.width);
	const height = toPositiveInt(dims.height);
	if (width == null || height == null) return null;
	return { width, height };
}

function toPositiveInt(value: unknown): number | null {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.round(n);
}
