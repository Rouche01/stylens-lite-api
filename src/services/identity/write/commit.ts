import type { ClothingItem } from '../../../types';
import { closetMatchProbeFromPrepared } from '../encode/probeEmbed';
import type { PreparedClosetCrop } from '../encode/cropEncoder';
import type { IdentityDecision } from '../decide/policy';
import { enqueueVectorRepair, extractionConfidence, failedItem } from './helpers';
import type { OutfitIdentityWriteDeps, ProcessedOutfitItem } from './types';

export async function commitNewItem(
	deps: OutfitIdentityWriteDeps,
	params: {
		userId: string;
		imageKey: string;
		outfitId: string;
		item: ClothingItem;
		ignoreClosetItemIds?: readonly string[];
		replaceMatchId?: string;
	},
	prepared: PreparedClosetCrop,
	decision: Extract<IdentityDecision, { action: 'create' }>
): Promise<ProcessedOutfitItem> {
	const closetItemId = crypto.randomUUID();

	try {
		const closetItem = await deps.closet.createClosetItem({
			id: closetItemId,
			userId: params.userId,
			label: params.item.label,
			category: params.item.category,
			subcategory: params.item.subcategory,
			color: params.item.color,
			pattern: params.item.pattern,
			styleTags: params.item.style_tags || [],
			probeEmbed: closetMatchProbeFromPrepared(prepared),
		});
		await deps.closet.linkClosetItemToOutfit({
			outfitId: params.outfitId,
			closetItemId: closetItem.id,
			boundingBox: params.item.bounding_box,
			confidence: extractionConfidence(params.item.confidence),
			blurHash: prepared.crop_blur_hash,
		});
		await indexCommittedItem(deps, {
			userId: params.userId,
			closetItemId: closetItem.id,
			category: params.item.category,
			prepared,
		});
		deps.log.info('outfit_identity_created', {
			outfit_id: params.outfitId,
			closet_item_id: closetItem.id,
			reason: decision.reason,
			identity_score: decision.identityScore ?? null,
			candidate_closet_item_id: decision.neighborClosetItemId ?? null,
			label: params.item.label,
		});
		return {
			...params.item,
			closet_item_id: closetItem.id,
			is_new_closet_item: true,
			identity_status: 'created',
			identity_reason: decision.reason,
			match_id: null,
			// Nearest declined neighbor (eval / calibration); null when no neighbor.
			candidate_closet_item_id: decision.neighborClosetItemId ?? null,
			identity_score: decision.identityScore ?? null,
		};
	} catch (err) {
		deps.log.warn(
			'outfit_identity_d1_failed',
			{ closet_item_id: closetItemId, outfit_id: params.outfitId },
			err
		);
		return failedItem(params.item, 'd1_failed', decision.identityScore);
	}
}

/**
 * Best-effort index after D1 commit. Never rolls back D1.
 * - writer (outfit process under identity_inflight): upsert now, then enqueue confirmation
 * - enqueue (resolve-new HTTP): mark indexing and enqueue onto CLOSET_IDENTITY_QUEUE only
 */
export async function indexCommittedItem(
	deps: OutfitIdentityWriteDeps,
	params: {
		userId: string;
		closetItemId: string;
		category: string;
		prepared: PreparedClosetCrop;
		matchId?: string;
		mode?: 'writer' | 'enqueue';
	}
): Promise<void> {
	const mode = params.mode ?? 'writer';
	await deps.closet.setClosetIndexStatus(params.closetItemId, 'indexing', {
		incrementAttempts: true,
	});
	if (mode === 'writer') {
		try {
			await deps.identity.upsertPreparedCrop(params.prepared, {
				userId: params.userId,
				category: params.category,
				closetItemId: params.closetItemId,
				log: deps.log,
			});
		} catch (err) {
			deps.log.warn(
				'outfit_identity_index_upsert_failed',
				{ closet_item_id: params.closetItemId },
				err
			);
		}
	}

	if (params.matchId) {
		await enqueueVectorRepair(deps, {
			kind: 'closet_vector_repair',
			closetItemId: params.closetItemId,
			matchId: params.matchId,
			userId: params.userId,
		});
		return;
	}
	await enqueueVectorRepair(deps, {
		kind: 'closet_vector_backfill',
		closetItemId: params.closetItemId,
	});
}
