

import { percentBoxIou } from '../utils/bounding_box';

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
}

export interface Outfit {
	id: string;
	user_id: string;
	original_image_url: string;
	image_key: string;
	created_at: number;
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
};

export type ClosetItemMatchWithOutfit = ClosetItemMatch & {
	outfit_image_key: string;
	outfit_original_image_url: string;
};

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
	async createOutfit(userId: string, imageUrl: string, imageKey: string): Promise<Outfit> {
		const id = crypto.randomUUID();
		const now = Date.now();

		await this.db
			.prepare(
				`
				INSERT INTO outfits (id, user_id, original_image_url, image_key, created_at)
				VALUES (?, ?, ?, ?, ?)
				`
			)
			.bind(id, userId, imageUrl, imageKey, now)
			.run();

		return {
			id,
			user_id: userId,
			original_image_url: imageUrl,
			image_key: imageKey,
			created_at: now
		};
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
	}): Promise<void> {
		const id = crypto.randomUUID();
		const now = Date.now();
		const boundingBoxJson = JSON.stringify(params.boundingBox);

		await this.db
			.prepare(
				`
				INSERT INTO outfit_clothing_items (id, outfit_id, closet_item_id, bounding_box, confidence, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
				`
			)
			.bind(id, params.outfitId, params.closetItemId, boundingBoxJson, params.confidence, now)
			.run();
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
					o.image_key
				FROM closet_items ci
				LEFT JOIN (
					-- Subquery to select the most recent link for each closet item
					SELECT closet_item_id, outfit_id, bounding_box, confidence, MAX(created_at) as max_created
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
				SELECT o.id as outfit_id, o.original_image_url, o.image_key, oci.bounding_box, oci.confidence, oci.created_at as worn_at
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
			worn_at: row.worn_at
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
		};
	}

	async listPendingMatches(userId: string): Promise<ClosetItemMatchWithOutfit[]> {
		const result = await this.db
			.prepare(
				`
				SELECT
					m.*,
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
					m.*,
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
