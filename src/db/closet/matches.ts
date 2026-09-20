import { percentBoxIou } from '../../utils/bounding_box';
import type { ClosetItemExtractSnapshot, ClosetItemMatch, ClosetItemMatchWithOutfit, ClosetMatchProbeEmbed } from './types';
import {
	CLOSET_MATCH_GET_COLUMNS,
	CLOSET_MATCH_LIST_COLUMNS,
	serializeClosetMatchProbeEmbed,
} from './types';
import { parseMatchWithOutfit, type ClosetItemMatchRow } from './parse';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => import('./base').ClosetDBBase;

export function WithClosetMatches<TBase extends Ctor>(Base: TBase) {
	return class extends Base {
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
			probeEmbed?: ClosetMatchProbeEmbed | null;
		}): Promise<ClosetItemMatch> {
			const id = crypto.randomUUID();
			const now = Date.now();
			const boundingBoxJson = JSON.stringify(params.boundingBox);
			const snapshotJson = JSON.stringify(params.extractSnapshot);
			const cosine = params.cosine ?? null;
			const colorDistance = params.colorDistance ?? null;
			const probeEmbed = params.probeEmbed ?? null;
			const probeEmbedJson = probeEmbed ? serializeClosetMatchProbeEmbed(probeEmbed) : null;

			await this.db
				.prepare(
					`
					INSERT INTO closet_item_matches (
						id, user_id, outfit_id, candidate_closet_item_id, bounding_box, confidence,
						extract_snapshot, score, cosine, color_distance, band, status, created_at, resolved_at,
						probe_embed
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ask', 'pending', ?, NULL, ?)
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
					now,
					probeEmbedJson
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
				probe_embed: probeEmbed,
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

		async getMatchByResolvedClosetItemId(closetItemId: string): Promise<ClosetItemMatchWithOutfit | null> {
			const row = await this.db
				.prepare(
					`
					SELECT
						${CLOSET_MATCH_GET_COLUMNS},
						o.image_key as outfit_image_key,
						o.original_image_url as outfit_original_image_url
					FROM closet_item_matches m
					INNER JOIN outfits o ON o.id = m.outfit_id
					WHERE m.resolved_closet_item_id = ? AND m.status = 'new'
					ORDER BY m.resolved_at DESC
					LIMIT 1
					`
				)
				.bind(closetItemId)
				.first<ClosetItemMatchRow>();

			return row ? parseMatchWithOutfit(row) : null;
		}

		async claimMatch(
			userId: string,
			matchId: string,
			params: { status: 'same' | 'new'; closetItemId: string }
		): Promise<boolean> {
			const result = await this.db
				.prepare(
					`
					UPDATE closet_item_matches
					SET status = ?, resolved_at = ?, resolved_closet_item_id = ?
					WHERE id = ? AND user_id = ? AND status = 'pending'
					`
				)
				.bind(params.status, Date.now(), params.closetItemId, matchId, userId)
				.run();

			return (result.meta.changes ?? 0) > 0;
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
				probeEmbed?: ClosetMatchProbeEmbed | null;
			}
		): Promise<boolean> {
			const probeEmbedJson = params.probeEmbed ? serializeClosetMatchProbeEmbed(params.probeEmbed) : null;
			const result = await this.db
				.prepare(
					`
					UPDATE closet_item_matches
					SET candidate_closet_item_id = ?, score = ?, cosine = ?, color_distance = ?, probe_embed = ?
					WHERE id = ? AND user_id = ? AND status = 'pending'
					`
				)
				.bind(
					params.candidateClosetItemId,
					params.score,
					params.cosine ?? null,
					params.colorDistance ?? null,
					probeEmbedJson,
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
	};
}
