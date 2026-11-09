import type { ClosetItemMatchWithOutfit } from '../../../db/closet';
import type { ExtractionConfidence } from '../../../types';
import { closetMatchProbeFromPrepared, preparedFromProbeEmbed } from '../encode/probeEmbed';
import type { PreparedClosetCrop } from '../encode/cropEncoder';
import { closetWearVectorId } from '../encode/vectorize.store';
import { logResolveCalibrationLabel } from '../logging/calibrationLabel';
import { indexCommittedItem } from './commit';
import { ClosetMatchNotFoundError, ClosetMatchResolvedError } from './errors';
import {
	clothingItemFromMatch,
	enqueueVectorRepair,
	extractionConfidence,
	notifyCatalog,
} from './helpers';
import type { OutfitIdentityWriteDeps, ResolveClosetMatchParams, ResolveClosetMatchResult } from './types';

export async function resolveClosetMatch(
	deps: OutfitIdentityWriteDeps,
	params: ResolveClosetMatchParams
): Promise<ResolveClosetMatchResult> {
	const match = await deps.closet.getMatchWithOutfit(params.userId, params.matchId);
	if (!match) {
		throw new ClosetMatchNotFoundError(params.matchId);
	}
	if (match.status !== 'pending') {
		return resumeResolvedMatch(deps, match, params.decision, params.signal);
	}

	if (params.decision === 'same') {
		return resolveSame(deps, match);
	}
	return resolveNew(deps, match, params.signal);
}

async function resolveSame(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit
): Promise<ResolveClosetMatchResult> {
	const candidate = await deps.closet.getClosetItemSummary(match.candidate_closet_item_id);
	if (!candidate) {
		throw new ClosetMatchNotFoundError(match.id);
	}

	const claimed = await deps.closet.claimMatch(match.user_id, match.id, {
		status: 'same',
		closetItemId: match.candidate_closet_item_id,
	});
	if (!claimed) {
		const latest = await deps.closet.getMatchWithOutfit(match.user_id, match.id);
		if (!latest) throw new ClosetMatchNotFoundError(match.id);
		return resumeResolvedMatch(deps, latest, 'same');
	}

	const result = await finishResolvedSame(deps, match);
	logResolveCalibrationLabel(deps.log, { match, decision: 'same', result });
	return result;
}

async function resolveNew(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	signal?: AbortSignal
): Promise<ResolveClosetMatchResult> {
	const item = clothingItemFromMatch(match);
	let prepared: PreparedClosetCrop;
	try {
		prepared = await preparedForResolve(deps, match, signal);
	} catch (err) {
		deps.log.warn(
			'outfit_identity_resolve_embed_failed',
			{ match_id: match.id, image_key: match.outfit_image_key },
			err
		);
		return {
			decision: 'new',
			match_id: match.id,
			closet_item_id: null,
			candidate_closet_item_id: match.candidate_closet_item_id,
			identity_status: 'failed',
			identity_reason: 'embed_failed',
			identity_score: match.score,
		};
	}

	const closetItemId = crypto.randomUUID();
	const claimed = await deps.closet.claimMatch(match.user_id, match.id, {
		status: 'new',
		closetItemId,
	});
	if (!claimed) {
		const latest = await deps.closet.getMatchWithOutfit(match.user_id, match.id);
		if (!latest) throw new ClosetMatchNotFoundError(match.id);
		return resumeResolvedMatch(deps, latest, 'new', signal);
	}

	try {
		await deps.closet.createClosetItem({
			id: closetItemId,
			userId: match.user_id,
			label: item.label,
			category: item.category,
			subcategory: item.subcategory,
			color: item.color,
			pattern: item.pattern,
			styleTags: item.style_tags || [],
			probeEmbed: closetMatchProbeFromPrepared(prepared),
		});
	} catch (err) {
		deps.log.warn(
			'outfit_identity_resolve_d1_failed',
			{ match_id: match.id, closet_item_id: closetItemId },
			err
		);
		return {
			decision: 'new',
			match_id: match.id,
			closet_item_id: closetItemId,
			candidate_closet_item_id: match.candidate_closet_item_id,
			identity_status: 'failed',
			identity_reason: 'd1_failed',
			identity_score: match.score,
		};
	}

	await indexCommittedItem(deps, {
		userId: match.user_id,
		closetItemId,
		category: item.category,
		prepared,
		matchId: match.id,
		mode: 'enqueue',
	});

	const result = await completeResolvedNew(deps, match, closetItemId, prepared.crop_blur_hash, false);
	logResolveCalibrationLabel(deps.log, { match, decision: 'new', result });
	return result;
}

async function resumeResolvedMatch(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	decision: 'same' | 'new',
	signal?: AbortSignal
): Promise<ResolveClosetMatchResult> {
	if (match.status !== decision) {
		throw new ClosetMatchResolvedError(match.id, match.status);
	}
	if (decision === 'same') {
		return finishResolvedSame(deps, match);
	}
	return resumeResolvedNew(deps, match, signal);
}

async function finishResolvedSame(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit
): Promise<ResolveClosetMatchResult> {
	const closetItemId = match.resolved_closet_item_id?.trim() || match.candidate_closet_item_id;
	const candidate = await deps.closet.getClosetItemSummary(closetItemId);
	if (!candidate) {
		throw new ClosetMatchNotFoundError(match.id);
	}

	await deps.closet.linkClosetItemToOutfit({
		outfitId: match.outfit_id,
		closetItemId,
		boundingBox: match.bounding_box,
		confidence: extractionConfidence(match.confidence as ExtractionConfidence),
		blurHash: await deps.closet.getLatestItemBlurHash(closetItemId),
	});

	await indexWearPrototype(deps, match, closetItemId);

	deps.log.info('outfit_identity_resolve_same', {
		match_id: match.id,
		outfit_id: match.outfit_id,
		closet_item_id: closetItemId,
	});
	await notifyCatalog(deps, match.user_id, match.outfit_id, [
		{
			closet_item_id: closetItemId,
			identity_status: 'created',
			category: match.extract_snapshot.category,
			subcategory: match.extract_snapshot.subcategory,
		},
	]);
	return {
		decision: 'same',
		match_id: match.id,
		closet_item_id: closetItemId,
		candidate_closet_item_id: match.candidate_closet_item_id,
		identity_status: 'created',
		identity_reason: 'same',
		identity_score: match.score,
	};
}

/**
 * Persist this wear's probe as an extra Vectorize vector on the confirmed closet item.
 * Best-effort: link already succeeded; a failed upsert only costs future lighting-drift recall.
 */
async function indexWearPrototype(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	closetItemId: string
): Promise<void> {
	const prepared = preparedFromProbeEmbed(match.probe_embed, match.outfit_image_key);
	if (!prepared) {
		deps.log.info('outfit_identity_wear_prototype_skipped', {
			match_id: match.id,
			closet_item_id: closetItemId,
			reason: 'no_probe',
		});
		return;
	}
	const category = match.extract_snapshot.category || 'top';
	try {
		const wearVectorId = closetWearVectorId(match.id);
		await deps.identity.upsertPreparedCrop(prepared, {
			id: wearVectorId,
			userId: match.user_id,
			category,
			closetItemId,
			log: deps.log,
		});
		deps.log.info('outfit_identity_wear_prototype_upserted', {
			match_id: match.id,
			closet_item_id: closetItemId,
			vector_id: wearVectorId,
		});
	} catch (err) {
		deps.log.warn(
			'outfit_identity_wear_prototype_failed',
			{ match_id: match.id, closet_item_id: closetItemId },
			err
		);
	}
}

async function resumeResolvedNew(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	signal?: AbortSignal
): Promise<ResolveClosetMatchResult> {
	const closetItemId = match.resolved_closet_item_id?.trim();
	if (!closetItemId) {
		throw new ClosetMatchNotFoundError(match.id);
	}

	const existing = await deps.closet.getClosetItemSummary(closetItemId);
	if (existing) {
		return completeResolvedNew(
			deps,
			match,
			closetItemId,
			await deps.closet.getLatestItemBlurHash(closetItemId),
			existing.vector_indexed_at == null
		);
	}

	return finishIncompleteResolvedNew(deps, match, closetItemId, signal);
}

async function finishIncompleteResolvedNew(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	closetItemId: string,
	signal?: AbortSignal
): Promise<ResolveClosetMatchResult> {
	const item = clothingItemFromMatch(match);
	let prepared: PreparedClosetCrop;
	try {
		prepared = await preparedForResolve(deps, match, signal);
	} catch (err) {
		deps.log.warn(
			'outfit_identity_resolve_embed_failed',
			{ match_id: match.id, image_key: match.outfit_image_key },
			err
		);
		return {
			decision: 'new',
			match_id: match.id,
			closet_item_id: closetItemId,
			candidate_closet_item_id: match.candidate_closet_item_id,
			identity_status: 'failed',
			identity_reason: 'embed_failed',
			identity_score: match.score,
		};
	}

	try {
		await deps.closet.createClosetItem({
			id: closetItemId,
			userId: match.user_id,
			label: item.label,
			category: item.category,
			subcategory: item.subcategory,
			color: item.color,
			pattern: item.pattern,
			styleTags: item.style_tags || [],
			probeEmbed: closetMatchProbeFromPrepared(prepared),
		});
	} catch (err) {
		const created = await deps.closet.getClosetItemSummary(closetItemId);
		if (!created) {
			deps.log.warn(
				'outfit_identity_resolve_d1_failed',
				{ match_id: match.id, closet_item_id: closetItemId },
				err
			);
			return {
				decision: 'new',
				match_id: match.id,
				closet_item_id: closetItemId,
				candidate_closet_item_id: match.candidate_closet_item_id,
				identity_status: 'failed',
				identity_reason: 'd1_failed',
				identity_score: match.score,
			};
		}
	}

	await indexCommittedItem(deps, {
		userId: match.user_id,
		closetItemId,
		category: item.category,
		prepared,
		matchId: match.id,
		mode: 'enqueue',
	});

	return completeResolvedNew(deps, match, closetItemId, prepared.crop_blur_hash, false);
}

async function completeResolvedNew(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	closetItemId: string,
	blurHash: string | null,
	enqueueRepair = true
): Promise<ResolveClosetMatchResult> {
	const item = clothingItemFromMatch(match);
	await deps.closet.linkClosetItemToOutfit({
		outfitId: match.outfit_id,
		closetItemId,
		boundingBox: match.bounding_box,
		confidence: extractionConfidence(item.confidence),
		blurHash,
	});

	deps.log.info('outfit_identity_resolve_new', {
		match_id: match.id,
		outfit_id: match.outfit_id,
		closet_item_id: closetItemId,
	});
	await notifyCatalog(deps, match.user_id, match.outfit_id, [
		{
			closet_item_id: closetItemId,
			identity_status: 'created',
			category: item.category,
			subcategory: item.subcategory,
		},
	]);
	if (enqueueRepair) {
		await enqueueVectorRepair(deps, {
			kind: 'closet_vector_repair',
			closetItemId,
			matchId: match.id,
			userId: match.user_id,
		});
	}
	return {
		decision: 'new',
		match_id: match.id,
		closet_item_id: closetItemId,
		candidate_closet_item_id: match.candidate_closet_item_id,
		identity_status: 'created',
		identity_reason: 'no_neighbor',
		identity_score: match.score,
	};
}

async function preparedForResolve(
	deps: OutfitIdentityWriteDeps,
	match: ClosetItemMatchWithOutfit,
	signal?: AbortSignal
): Promise<PreparedClosetCrop> {
	const fromProbe = preparedFromProbeEmbed(match.probe_embed, match.outfit_image_key);
	if (fromProbe) return fromProbe;
	return deps.identity.prepareClosetCrop({
		imageKey: match.outfit_image_key,
		boundingBox: match.bounding_box,
		category: match.extract_snapshot.category,
		subcategory: match.extract_snapshot.subcategory,
		signal,
	});
}
