import type { ClosetIndexStatus, ClosetItemMatchWithOutfit, ClosetMatchProbeEmbed } from './types';
import {
	CLOSET_MATCH_GET_COLUMNS,
	parseClosetIndexStatus,
	parseClosetMatchProbeEmbed,
} from './types';
import { parseJsonBox, parseMatchWithOutfit, type ClosetItemMatchRow } from './parse';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => import('./base').ClosetDBBase;

export function WithClosetVectors<TBase extends Ctor>(Base: TBase) {
	return class extends Base {
		async getClosetItemSummary(itemId: string): Promise<{
			id: string;
			user_id: string;
			label: string;
			category: string;
			vector_indexed_at: number | null;
			index_status: ClosetIndexStatus | null;
			index_attempts: number;
		} | null> {
			const row = await this.db
				.prepare(
					`
					SELECT id, user_id, label, category, vector_indexed_at, index_status, index_attempts
					FROM closet_items WHERE id = ?
					`
				)
				.bind(itemId)
				.first<{
					id: string;
					user_id: string;
					label: string;
					category: string;
					vector_indexed_at: number | null;
					index_status: string | null;
					index_attempts: number | null;
				}>();
			if (!row) return null;
			return {
				id: row.id,
				user_id: row.user_id,
				label: row.label,
				category: row.category,
				vector_indexed_at: row.vector_indexed_at ?? null,
				index_status: parseClosetIndexStatus(row.index_status),
				index_attempts: row.index_attempts ?? 0,
			};
		}

		async stampVectorIndexedAt(itemId: string, atMs = Date.now()): Promise<boolean> {
			const result = await this.db
				.prepare(
					`
					UPDATE closet_items
					SET vector_indexed_at = ?, index_status = 'indexed', updated_at = ?
					WHERE id = ? AND vector_indexed_at IS NULL
					`
				)
				.bind(atMs, atMs, itemId)
				.run();
			return (result.meta.changes ?? 0) > 0;
		}

		async stampVectorIndexedAtMany(itemIds: readonly string[], atMs = Date.now()): Promise<number> {
			const ids = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
			if (ids.length === 0) return 0;
			const statements = ids.map((id) =>
				this.db
					.prepare(
						`
						UPDATE closet_items
						SET vector_indexed_at = ?, index_status = 'indexed', updated_at = ?
						WHERE id = ? AND vector_indexed_at IS NULL
						`
					)
					.bind(atMs, atMs, id)
			);
			const results = await this.db.batch(statements);
			return results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
		}

		/**
		 * Mark indexing in flight (increments attempts) or degraded after budget exhaust.
		 * No-ops when already stamped indexed.
		 */
		async setClosetIndexStatus(
			itemId: string,
			status: Exclude<ClosetIndexStatus, 'indexed'>,
			params?: { incrementAttempts?: boolean }
		): Promise<boolean> {
			const now = Date.now();
			if (params?.incrementAttempts) {
				const result = await this.db
					.prepare(
						`
						UPDATE closet_items
						SET index_status = ?, index_attempts = COALESCE(index_attempts, 0) + 1, updated_at = ?
						WHERE id = ? AND vector_indexed_at IS NULL
						`
					)
					.bind(status, now, itemId)
					.run();
				return (result.meta.changes ?? 0) > 0;
			}
			const result = await this.db
				.prepare(
					`
					UPDATE closet_items
					SET index_status = ?, updated_at = ?
					WHERE id = ? AND vector_indexed_at IS NULL
					`
				)
				.bind(status, now, itemId)
				.run();
			return (result.meta.changes ?? 0) > 0;
		}

		async listUnindexedClosetItemIds(limit = 200): Promise<string[]> {
			const result = await this.db
				.prepare(
					`
					SELECT id FROM closet_items
					WHERE vector_indexed_at IS NULL
						AND COALESCE(index_status, 'committed') != 'indexed'
					ORDER BY created_at ASC
					LIMIT ?
					`
				)
				.bind(limit)
				.all<{ id: string }>();
			return (result.results ?? []).map((row) => row.id).filter(Boolean);
		}

		/**
		 * User tiles still waiting on Vectorize (committed/indexing).
		 * Excludes index_degraded — those already exhausted the gate budget.
		 */
		async getClosetItemProbeEmbed(itemId: string): Promise<ClosetMatchProbeEmbed | null> {
			const row = await this.db
				.prepare(`SELECT probe_embed FROM closet_items WHERE id = ?`)
				.bind(itemId)
				.first<{ probe_embed: string | null }>();
			return parseClosetMatchProbeEmbed(row?.probe_embed);
		}

		async listPendingIndexClosetItemIdsForUser(userId: string, limit = 50): Promise<string[]> {
			const result = await this.db
				.prepare(
					`
					SELECT id FROM closet_items
					WHERE user_id = ?
						AND vector_indexed_at IS NULL
						AND COALESCE(index_status, 'committed') IN ('committed', 'indexing')
					ORDER BY created_at ASC
					LIMIT ?
					`
				)
				.bind(userId, limit)
				.all<{ id: string }>();
			return (result.results ?? []).map((row) => row.id).filter(Boolean);
		}

		/**
		 * Recent unindexed / degraded tiles with stored probes for local identity scoring.
		 */
		async listRecentUnindexedProbes(
			userId: string,
			params?: { limit?: number; maxAgeMs?: number }
		): Promise<
			Array<{
				closetItemId: string;
				category: string;
				label: string;
				probeEmbed: ClosetMatchProbeEmbed;
				indexStatus: ClosetIndexStatus | null;
				createdAt: number;
			}>
		> {
			const limit = params?.limit ?? 25;
			const maxAgeMs = params?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
			const minCreatedAt = Date.now() - maxAgeMs;
			const result = await this.db
				.prepare(
					`
					SELECT id, category, label, probe_embed, index_status, created_at
					FROM closet_items
					WHERE user_id = ?
						AND vector_indexed_at IS NULL
						AND COALESCE(index_status, 'committed') IN ('committed', 'indexing', 'index_degraded')
						AND probe_embed IS NOT NULL
						AND created_at >= ?
					ORDER BY created_at DESC
					LIMIT ?
					`
				)
				.bind(userId, minCreatedAt, limit)
				.all<{
					id: string;
					category: string;
					label: string;
					probe_embed: string;
					index_status: string | null;
					created_at: number;
				}>();

			const rows: Array<{
				closetItemId: string;
				category: string;
				label: string;
				probeEmbed: ClosetMatchProbeEmbed;
				indexStatus: ClosetIndexStatus | null;
				createdAt: number;
			}> = [];
			for (const row of result.results ?? []) {
				const probeEmbed = parseClosetMatchProbeEmbed(row.probe_embed);
				if (!probeEmbed) continue;
				rows.push({
					closetItemId: row.id,
					category: row.category,
					label: row.label,
					probeEmbed,
					indexStatus: parseClosetIndexStatus(row.index_status),
					createdAt: row.created_at,
				});
			}
			return rows;
		}

		async listClaimedNewMatchesWithoutItem(limit = 25): Promise<ClosetItemMatchWithOutfit[]> {
			const result = await this.db
				.prepare(
					`
					SELECT
						${CLOSET_MATCH_GET_COLUMNS},
						o.image_key as outfit_image_key,
						o.original_image_url as outfit_original_image_url
					FROM closet_item_matches m
					INNER JOIN outfits o ON o.id = m.outfit_id
					LEFT JOIN closet_items ci ON ci.id = m.resolved_closet_item_id
					WHERE m.status = 'new'
						AND m.resolved_closet_item_id IS NOT NULL
						AND ci.id IS NULL
					ORDER BY m.resolved_at ASC
					LIMIT ?
					`
				)
				.bind(limit)
				.all<ClosetItemMatchRow>();
			return (result.results ?? []).map(parseMatchWithOutfit);
		}

		async getLatestWearImageForClosetItem(closetItemId: string): Promise<{
			imageKey: string;
			boundingBox: { x: number; y: number; width: number; height: number };
		} | null> {
			const row = await this.db
				.prepare(
					`
					SELECT o.image_key as image_key, oci.bounding_box as bounding_box
					FROM outfit_clothing_items oci
					JOIN outfits o ON o.id = oci.outfit_id
					WHERE oci.closet_item_id = ?
					ORDER BY oci.created_at DESC
					LIMIT 1
					`
				)
				.bind(closetItemId)
				.first<{ image_key: string; bounding_box: string }>();
			if (!row?.image_key?.trim() || !row.bounding_box) return null;
			return { imageKey: row.image_key, boundingBox: parseJsonBox(row.bounding_box) };
		}
	};
}
