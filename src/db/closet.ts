

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
	 * Queries the user's closet for an existing item that matches the given attributes (for deduplication).
	 */
	async findMatchingClosetItem(params: {
		userId: string;
		category: string;
		subcategory: string;
		color: string;
		pattern: string;
	}): Promise<ClosetItem | null> {
		const result = await this.db
			.prepare(
				`
				SELECT * FROM closet_items
				WHERE user_id = ?
				  AND LOWER(category) = LOWER(?)
				  AND LOWER(subcategory) = LOWER(?)
				  AND LOWER(color) = LOWER(?)
				  AND LOWER(pattern) = LOWER(?)
				LIMIT 1
				`
			)
			.bind(params.userId, params.category, params.subcategory, params.color, params.pattern)
			.first<any>();

		if (!result) return null;

		return {
			...result,
			style_tags: result.style_tags ? JSON.parse(result.style_tags) : []
		};
	}

	/**
	 * Creates a new persistent closet item.
	 */
	async createClosetItem(params: {
		userId: string;
		label: string;
		category: string;
		subcategory: string;
		color: string;
		pattern: string;
		styleTags: string[];
	}): Promise<ClosetItem> {
		const id = crypto.randomUUID();
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
	 * Retrieves detailed history and statistics for a specific closet item.
	 */
	async getClosetItemDetails(userId: string, itemId: string): Promise<ClosetItemDetails | null> {
		// 1. Fetch core closet item
		const itemRow = await this.db
			.prepare(`SELECT * FROM closet_items WHERE id = ? AND user_id = ?`)
			.bind(itemId, userId)
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
