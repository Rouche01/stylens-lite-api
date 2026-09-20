import type {
	ClosetItem,
	ClosetItemDetails,
	ClosetMatchProbeEmbed,
	Outfit,
	OutfitLinkedItem,
} from './types';
import { closetTileAspectRatio, mapOutfitRow, normalizeImageDimensions } from './parse';
import { serializeClosetMatchProbeEmbed } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => import('./base').ClosetDBBase;

export function WithClosetItems<TBase extends Ctor>(Base: TBase) {
	return class extends Base {
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
			probeEmbed?: ClosetMatchProbeEmbed | null;
		}): Promise<ClosetItem> {
			const id = params.id?.trim() || crypto.randomUUID();
			const now = Date.now();
			const styleTagsJson = JSON.stringify(params.styleTags);
			const probeEmbedJson = params.probeEmbed
				? serializeClosetMatchProbeEmbed(params.probeEmbed)
				: null;

			await this.db
				.prepare(
					`
					INSERT INTO closet_items (
						id, user_id, label, category, subcategory, color, pattern, style_tags,
						created_at, updated_at, vector_id, index_status, index_attempts, probe_embed
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', 0, ?)
					`
				)
				.bind(
					id,
					params.userId,
					params.label,
					params.category,
					params.subcategory,
					params.color,
					params.pattern,
					styleTagsJson,
					now,
					now,
					`item:${id}`,
					probeEmbedJson
				)
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
				updated_at: now,
				vector_id: `item:${id}`,
				vector_indexed_at: null,
				index_status: 'committed',
				index_attempts: 0,
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
			const now = Date.now();
			const boundingBoxJson = JSON.stringify(params.boundingBox);
			const blurHash = params.blurHash?.trim() || null;

			const existing = await this.db
				.prepare(
					`
					SELECT id FROM outfit_clothing_items
					WHERE outfit_id = ? AND closet_item_id = ? AND bounding_box = ?
					LIMIT 1
					`
				)
				.bind(params.outfitId, params.closetItemId, boundingBoxJson)
				.first<{ id: string }>();
			if (existing) return;

			await this.db
				.prepare(
					`
					INSERT INTO outfit_clothing_items (id, outfit_id, closet_item_id, bounding_box, confidence, blur_hash, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					`
				)
				.bind(crypto.randomUUID(), params.outfitId, params.closetItemId, boundingBoxJson, params.confidence, blurHash, now)
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
	};
}
