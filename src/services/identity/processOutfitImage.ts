import { createClosetDB, ClosetDB } from '../../db';
import type { ClosetItemExtractSnapshot, ClosetItemMatchWithOutfit } from '../../db/closet';
import {
	ClothingItem,
	ClothingItemCategory,
	ClothingItemPattern,
	ClothingItemSubcategory,
	ExtractionConfidence,
	OutfitExtractionResponse,
} from '../../types';
import { isUsableIdentityBox } from '../../utils/bounding_box';
import { Logger, createLogger } from '../../utils/logger.utils';
import { createOutfitExtractionService, OutfitExtractionService } from '../outfit_extraction.svc';
import { createRealtimeService } from '../realtime.svc';
import {
	createIdentityService,
	IdentityService,
	type PreparedClosetCrop,
	type QueryClosetCropMatch,
} from './identity.svc';
import { isIdentityMatch } from './cropColor';
import { closetItemVectorId } from './vectorize.store';
import { closetMatchProbeFromPrepared, preparedFromProbeEmbed } from './probeEmbed';
import type { ClosetVectorBackfillJob, ClosetVectorRepairJob } from './closetVectorRepair';
import { createClosetMatchDigestScheduler } from './closetMatchDigest';
import {
	createClosetCatalogNotifier,
	type ClosetCatalogNotifier,
} from './closetCatalogBroadcast';
import type { ClosetCatalogNotifyItem } from '../../utils/closet_browse';

export type OutfitIdentityExtractor = Pick<OutfitExtractionService, 'extractOutfitItems'>;
export type OutfitIdentityQueries = Pick<
	IdentityService,
	'prepareClosetCrop' | 'queryPreparedCrop' | 'upsertPreparedCrop'
>;
export type OutfitIdentityStore = Pick<
	ClosetDB,
	| 'createOutfit'
	| 'getOutfitByUserImageKey'
	| 'setOutfitImageDimensionsIfMissing'
	| 'createClosetItem'
	| 'linkClosetItemToOutfit'
	| 'getLatestItemBlurHash'
	| 'createPendingMatch'
	| 'findClosetItemForPhotoCrop'
	| 'getClosetItemSummary'
	| 'tryAcquireIdentityLock'
	| 'releaseIdentityLock'
	| 'getMatchWithOutfit'
	| 'claimMatch'
	| 'updatePendingMatch'
	| 'touchMatchAsk'
	| 'setClosetIndexStatus'
>;

export type ClosetVectorRepairScheduler = {
	send(
		job: ClosetVectorRepairJob | ClosetVectorBackfillJob,
		options?: QueueSendOptions
	): Promise<unknown>;
};

export type ClosetMatchDigestScheduler = {
	schedule(userId: string): Promise<void>;
};

export class ClosetMatchNotFoundError extends Error {
	constructor(matchId: string) {
		super(`Closet match ${matchId} was not found`);
		this.name = 'ClosetMatchNotFoundError';
	}
}

export class ClosetMatchResolvedError extends Error {
	constructor(matchId: string, status: string) {
		super(`Closet match ${matchId} is already ${status}`);
		this.name = 'ClosetMatchResolvedError';
	}
}

export type ResolveClosetMatchParams = {
	userId: string;
	matchId: string;
	decision: 'same' | 'new';
	signal?: AbortSignal;
};

export type ResolveClosetMatchResult = {
	decision: 'same' | 'new' | 'ask';
	match_id: string;
	closet_item_id: string | null;
	candidate_closet_item_id: string | null;
	identity_status: 'created' | 'ask' | 'failed';
	identity_reason: IdentityCreateReason | 'ask' | 'same';
	identity_score: number | null;
};

export type IdentityWait = {
	sleep: (ms: number) => Promise<void>;
};

export type ProcessOutfitImageParams = {
	userId: string;
	imageUrl: string;
	imageKey: string;
	signal?: AbortSignal;
	cachedExtraction?: OutfitExtractionResponse;
	onExtracted?: (extraction: OutfitExtractionResponse) => Promise<void>;
};

export type IdentityCreateReason =
	| 'skip_query'
	| 'no_neighbor'
	| 'below_threshold'
	| 'identity_error'
	| 'missing_candidate'
	| 'upsert_failed'
	| 'embed_failed'
	| 'visibility_timeout'
	| 'd1_failed'
	| 'race_lost'
	| 'existing_crop';

export type IdentityDecision =
	| { action: 'create'; reason: IdentityCreateReason; identityScore?: number | null }
	| {
			action: 'ask';
			candidateClosetItemId: string;
			identityScore: number;
			cosine: number;
			colorDistance: number | null;
	  };

export type CommitDecision =
	| { action: 'commit' }
	| {
			action: 'ask';
			candidateClosetItemId: string;
			identityScore: number;
			cosine: number;
			colorDistance: number | null;
	  }
	| {
			action: 'yield';
			winnerId: string;
			identityScore: number;
			cosine: number;
			colorDistance: number | null;
	  };

export type ProcessedOutfitItem = ClothingItem & {
	closet_item_id: string | null;
	is_new_closet_item: boolean;
	identity_status: 'created' | 'ask' | 'failed';
	identity_reason: IdentityCreateReason | 'ask';
	match_id: string | null;
	candidate_closet_item_id: string | null;
	identity_score: number | null;
};

export type ProcessOutfitImageResult = {
	outfit_id: string;
	image_key: string;
	extraction: OutfitExtractionResponse;
	items: ProcessedOutfitItem[];
};

const DEFAULT_WAIT: IdentityWait = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const LOCK_RETRY_COUNT = 8;
const LOCK_RETRY_MS = 250;

export class IdentityBusyError extends Error {
	constructor(userId: string) {
		super(`Identity already in progress for user ${userId}`);
		this.name = 'IdentityBusyError';
	}
}

export function candidateClosetItemId(match: QueryClosetCropMatch | undefined): string | null {
	if (!match) return null;
	const d1 = match.d1_closet_item_id?.trim();
	if (d1) return d1;
	const meta = match.closet_item_id?.trim();
	if (meta && !meta.startsWith('scratch:')) return meta;
	return null;
}

export function neighborsExcludingSelf(
	neighbors: QueryClosetCropMatch[],
	selfClosetItemId: string
): QueryClosetCropMatch[] {
	const selfVectorId = closetItemVectorId(selfClosetItemId);
	return neighbors.filter(
		(match) => match.id !== selfVectorId && match.closet_item_id !== selfClosetItemId
	);
}

export function decideIdentityFromNeighbors(neighbors: QueryClosetCropMatch[]): IdentityDecision {
	const top = neighbors[0];
	if (!top) {
		return { action: 'create', reason: 'no_neighbor' };
	}
	if (!isIdentityMatch(top.identity_score)) {
		return { action: 'create', reason: 'below_threshold', identityScore: top.identity_score };
	}
	const candidateId = candidateClosetItemId(top);
	if (!candidateId) {
		return { action: 'create', reason: 'missing_candidate', identityScore: top.identity_score };
	}
	return {
		action: 'ask',
		candidateClosetItemId: candidateId,
		identityScore: top.identity_score,
		cosine: top.score,
		colorDistance: top.color_distance,
	};
}

export function decideCommitAfterRequery(
	selfClosetItemId: string,
	neighbors: QueryClosetCropMatch[],
	ignoreClosetItemIds: readonly string[] = []
): CommitDecision {
	const ignored = new Set(ignoreClosetItemIds);
	const contenders = neighborsExcludingSelf(neighbors, selfClosetItemId).filter((match) => {
		if (!isIdentityMatch(match.identity_score)) return false;
		const candidateId = candidateClosetItemId(match);
		if (candidateId && ignored.has(candidateId)) return false;
		if (match.closet_item_id && ignored.has(match.closet_item_id)) return false;
		return true;
	});
	if (contenders.length === 0) {
		return { action: 'commit' };
	}

	const committed = contenders
		.filter((match) => match.d1_closet_item_id)
		.sort((a, b) => b.identity_score - a.identity_score);
	if (committed[0]?.d1_closet_item_id) {
		return {
			action: 'ask',
			candidateClosetItemId: committed[0].d1_closet_item_id,
			identityScore: committed[0].identity_score,
			cosine: committed[0].score,
			colorDistance: committed[0].color_distance,
		};
	}

	const rivalIds = contenders
		.map((match) => match.closet_item_id?.trim())
		.filter((id): id is string => Boolean(id) && !id.startsWith('scratch:'));
	const winnerId = [selfClosetItemId, ...rivalIds].sort()[0];
	if (winnerId === selfClosetItemId) {
		return { action: 'commit' };
	}
	const rival = contenders.find((match) => match.closet_item_id === winnerId) ?? contenders[0];
	return {
		action: 'yield',
		winnerId,
		identityScore: rival.identity_score,
		cosine: rival.score,
		colorDistance: rival.color_distance,
	};
}

export function shouldQueryIdentity(item: ClothingItem): boolean {
	if (item.confidence === ExtractionConfidence.LOW) {
		return false;
	}
	return isUsableIdentityBox(item.bounding_box);
}

export class OutfitIdentityProcessor {
	constructor(
		private extract: OutfitIdentityExtractor,
		private identity: OutfitIdentityQueries,
		private closet: OutfitIdentityStore,
		private log: Logger,
		private wait: IdentityWait = DEFAULT_WAIT,
		private digest?: ClosetMatchDigestScheduler,
		private catalog?: ClosetCatalogNotifier,
		private repairQueue?: ClosetVectorRepairScheduler
	) {}

	async process(params: ProcessOutfitImageParams): Promise<ProcessOutfitImageResult | null> {
		let extracted = params.cachedExtraction;
		if (!extracted) {
			extracted =
				(await this.extract.extractOutfitItems({
					imageUrl: params.imageUrl,
					signal: params.signal,
				})) ?? undefined;
			if (extracted) {
				try {
					await params.onExtracted?.(extracted);
				} catch (err) {
					this.log.warn('outfit_identity_cache_extract_failed', { image_key: params.imageKey }, err);
				}
			}
		}
		if (!extracted) {
			return null;
		}

		const jobId = crypto.randomUUID();
		const acquired = await this.acquireLock(params.userId, jobId);
		if (!acquired) {
			throw new IdentityBusyError(params.userId);
		}

		try {
			const dims = extracted.image_dimensions;
			const outfit =
				(await this.closet.getOutfitByUserImageKey(params.userId, params.imageKey)) ??
				(await this.closet.createOutfit(params.userId, params.imageUrl, params.imageKey, dims));
			if (outfit.image_width == null || outfit.image_height == null) {
				await this.closet.setOutfitImageDimensionsIfMissing(outfit.id, dims.width, dims.height);
			}
			const items: ProcessedOutfitItem[] = [];
			for (const item of extracted.items) {
				items.push(
					await this.processItem({
						userId: params.userId,
						imageKey: params.imageKey,
						outfitId: outfit.id,
						item,
						signal: params.signal,
					})
				);
			}

			if (items.some((item) => item.identity_status === 'ask')) {
				await this.scheduleDigest(params.userId);
			}

			return {
				outfit_id: outfit.id,
				image_key: params.imageKey,
				extraction: extracted,
				items,
			};
		} finally {
			await this.closet.releaseIdentityLock(params.userId, jobId);
		}
	}

	async resolveMatch(params: ResolveClosetMatchParams): Promise<ResolveClosetMatchResult> {
		const match = await this.closet.getMatchWithOutfit(params.userId, params.matchId);
		if (!match) {
			throw new ClosetMatchNotFoundError(params.matchId);
		}
		if (match.status !== 'pending') {
			return this.resumeResolvedMatch(match, params.decision, params.signal);
		}

		if (params.decision === 'same') {
			return this.resolveSame(match);
		}
		return this.resolveNew(match, params.signal);
	}

	private async acquireLock(userId: string, jobId: string): Promise<boolean> {
		for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
			if (await this.closet.tryAcquireIdentityLock(userId, jobId)) {
				return true;
			}
			await this.wait.sleep(LOCK_RETRY_MS);
		}
		return false;
	}

	private async processItem(params: {
		userId: string;
		imageKey: string;
		outfitId: string;
		item: ClothingItem;
		signal?: AbortSignal;
	}): Promise<ProcessedOutfitItem> {
		const existing = await this.closet.findClosetItemForPhotoCrop(
			params.userId,
			params.imageKey,
			params.item.bounding_box
		);
		if (existing) {
			await this.closet.linkClosetItemToOutfit({
				outfitId: params.outfitId,
				closetItemId: existing.id,
				boundingBox: params.item.bounding_box,
				confidence: extractionConfidence(params.item.confidence),
				blurHash: await this.closet.getLatestItemBlurHash(existing.id),
			});
			this.log.info('outfit_identity_existing_crop', {
				outfit_id: params.outfitId,
				closet_item_id: existing.id,
				label: params.item.label,
			});
			return {
				...params.item,
				closet_item_id: existing.id,
				is_new_closet_item: false,
				identity_status: 'created',
				identity_reason: 'existing_crop',
				match_id: null,
				candidate_closet_item_id: null,
				identity_score: null,
			};
		}

		let prepared: PreparedClosetCrop;
		try {
			prepared = await this.identity.prepareClosetCrop({
				imageKey: params.imageKey,
				boundingBox: params.item.bounding_box,
				signal: params.signal,
			});
		} catch (err) {
			this.log.warn(
				'outfit_identity_embed_failed',
				{ image_key: params.imageKey, label: params.item.label },
				err
			);
			return failedItem(params.item, 'embed_failed');
		}

		const decision = await this.decideItem(params, prepared);
		if (decision.action === 'ask') {
			return this.persistAsk(params, decision, prepared);
		}

		return this.commitNewItem(params, prepared, decision);
	}

	private async decideItem(
		params: {
			userId: string;
			imageKey: string;
			item: ClothingItem;
		},
		prepared: PreparedClosetCrop
	): Promise<IdentityDecision> {
		if (!shouldQueryIdentity(params.item)) {
			return { action: 'create', reason: 'skip_query' };
		}
		try {
			const queried = await this.identity.queryPreparedCrop(prepared, {
				imageKey: params.imageKey,
				boundingBox: params.item.bounding_box,
				userId: params.userId,
				category: params.item.category,
			});
			return decideIdentityFromNeighbors(queried.neighbors);
		} catch (err) {
			this.log.warn(
				'outfit_identity_query_failed',
				{
					image_key: params.imageKey,
					label: params.item.label,
					category: params.item.category,
				},
				err
			);
			return { action: 'create', reason: 'identity_error' };
		}
	}

	private async commitNewItem(
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
			const closetItem = await this.closet.createClosetItem({
				id: closetItemId,
				userId: params.userId,
				label: params.item.label,
				category: params.item.category,
				subcategory: params.item.subcategory,
				color: params.item.color,
				pattern: params.item.pattern,
				styleTags: params.item.style_tags || [],
			});
			await this.closet.linkClosetItemToOutfit({
				outfitId: params.outfitId,
				closetItemId: closetItem.id,
				boundingBox: params.item.bounding_box,
				confidence: extractionConfidence(params.item.confidence),
				blurHash: prepared.crop_blur_hash,
			});
			await this.indexCommittedItem({
				userId: params.userId,
				closetItemId: closetItem.id,
				category: params.item.category,
				prepared,
			});
			this.log.info('outfit_identity_created', {
				outfit_id: params.outfitId,
				closet_item_id: closetItem.id,
				reason: decision.reason,
				label: params.item.label,
			});
			return {
				...params.item,
				closet_item_id: closetItem.id,
				is_new_closet_item: true,
				identity_status: 'created',
				identity_reason: decision.reason,
				match_id: null,
				candidate_closet_item_id: null,
				identity_score: decision.identityScore ?? null,
			};
		} catch (err) {
			this.log.warn(
				'outfit_identity_d1_failed',
				{ closet_item_id: closetItemId, outfit_id: params.outfitId },
				err
			);
			return failedItem(params.item, 'd1_failed', decision.identityScore);
		}
	}

	/**
	 * Best-effort Vectorize write + queue index confirmation. Never rolls back D1.
	 */
	private async indexCommittedItem(params: {
		userId: string;
		closetItemId: string;
		category: string;
		prepared: PreparedClosetCrop;
		matchId?: string;
	}): Promise<void> {
		await this.closet.setClosetIndexStatus(params.closetItemId, 'indexing', {
			incrementAttempts: true,
		});
		try {
			await this.identity.upsertPreparedCrop(params.prepared, {
				userId: params.userId,
				category: params.category,
				closetItemId: params.closetItemId,
			});
		} catch (err) {
			this.log.warn(
				'outfit_identity_index_upsert_failed',
				{ closet_item_id: params.closetItemId },
				err
			);
		}

		if (params.matchId) {
			await this.enqueueVectorRepair({
				kind: 'closet_vector_repair',
				closetItemId: params.closetItemId,
				matchId: params.matchId,
				userId: params.userId,
			});
			return;
		}
		await this.enqueueVectorRepair({
			kind: 'closet_vector_backfill',
			closetItemId: params.closetItemId,
		});
	}

	private async resolveSame(match: ClosetItemMatchWithOutfit): Promise<ResolveClosetMatchResult> {
		const candidate = await this.closet.getClosetItemSummary(match.candidate_closet_item_id);
		if (!candidate) {
			throw new ClosetMatchNotFoundError(match.id);
		}

		const claimed = await this.closet.claimMatch(match.user_id, match.id, {
			status: 'same',
			closetItemId: match.candidate_closet_item_id,
		});
		if (!claimed) {
			const latest = await this.closet.getMatchWithOutfit(match.user_id, match.id);
			if (!latest) throw new ClosetMatchNotFoundError(match.id);
			return this.resumeResolvedMatch(latest, 'same');
		}

		return this.finishResolvedSame(match);
	}

	private async resolveNew(
		match: ClosetItemMatchWithOutfit,
		signal?: AbortSignal
	): Promise<ResolveClosetMatchResult> {
		const item = clothingItemFromMatch(match);
		let prepared: PreparedClosetCrop;
		try {
			prepared = await this.preparedForResolve(match, signal);
		} catch (err) {
			this.log.warn(
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
		const claimed = await this.closet.claimMatch(match.user_id, match.id, {
			status: 'new',
			closetItemId,
		});
		if (!claimed) {
			const latest = await this.closet.getMatchWithOutfit(match.user_id, match.id);
			if (!latest) throw new ClosetMatchNotFoundError(match.id);
			return this.resumeResolvedMatch(latest, 'new', signal);
		}

		try {
			await this.closet.createClosetItem({
				id: closetItemId,
				userId: match.user_id,
				label: item.label,
				category: item.category,
				subcategory: item.subcategory,
				color: item.color,
				pattern: item.pattern,
				styleTags: item.style_tags || [],
			});
		} catch (err) {
			this.log.warn(
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

		await this.indexCommittedItem({
			userId: match.user_id,
			closetItemId,
			category: item.category,
			prepared,
			matchId: match.id,
		});

		return this.completeResolvedNew(match, closetItemId, prepared.crop_blur_hash, false);
	}

	private async resumeResolvedMatch(
		match: ClosetItemMatchWithOutfit,
		decision: 'same' | 'new',
		signal?: AbortSignal
	): Promise<ResolveClosetMatchResult> {
		if (match.status !== decision) {
			throw new ClosetMatchResolvedError(match.id, match.status);
		}
		if (decision === 'same') {
			return this.finishResolvedSame(match);
		}
		return this.resumeResolvedNew(match, signal);
	}

	private async finishResolvedSame(match: ClosetItemMatchWithOutfit): Promise<ResolveClosetMatchResult> {
		const closetItemId = match.resolved_closet_item_id?.trim() || match.candidate_closet_item_id;
		const candidate = await this.closet.getClosetItemSummary(closetItemId);
		if (!candidate) {
			throw new ClosetMatchNotFoundError(match.id);
		}

		await this.closet.linkClosetItemToOutfit({
			outfitId: match.outfit_id,
			closetItemId,
			boundingBox: match.bounding_box,
			confidence: extractionConfidence(match.confidence as ExtractionConfidence),
			blurHash: await this.closet.getLatestItemBlurHash(closetItemId),
		});

		this.log.info('outfit_identity_resolve_same', {
			match_id: match.id,
			outfit_id: match.outfit_id,
			closet_item_id: closetItemId,
		});
		await this.notifyCatalog(match.user_id, match.outfit_id, [
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

	private async resumeResolvedNew(
		match: ClosetItemMatchWithOutfit,
		signal?: AbortSignal
	): Promise<ResolveClosetMatchResult> {
		const closetItemId = match.resolved_closet_item_id?.trim();
		if (!closetItemId) {
			throw new ClosetMatchNotFoundError(match.id);
		}

		const existing = await this.closet.getClosetItemSummary(closetItemId);
		if (existing) {
			return this.completeResolvedNew(
				match,
				closetItemId,
				await this.closet.getLatestItemBlurHash(closetItemId),
				existing.vector_indexed_at == null
			);
		}

		return this.finishIncompleteResolvedNew(match, closetItemId, signal);
	}

	private async finishIncompleteResolvedNew(
		match: ClosetItemMatchWithOutfit,
		closetItemId: string,
		signal?: AbortSignal
	): Promise<ResolveClosetMatchResult> {
		const item = clothingItemFromMatch(match);
		let prepared: PreparedClosetCrop;
		try {
			prepared = await this.preparedForResolve(match, signal);
		} catch (err) {
			this.log.warn(
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
			await this.closet.createClosetItem({
				id: closetItemId,
				userId: match.user_id,
				label: item.label,
				category: item.category,
				subcategory: item.subcategory,
				color: item.color,
				pattern: item.pattern,
				styleTags: item.style_tags || [],
			});
		} catch (err) {
			const created = await this.closet.getClosetItemSummary(closetItemId);
			if (!created) {
				this.log.warn(
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

		await this.indexCommittedItem({
			userId: match.user_id,
			closetItemId,
			category: item.category,
			prepared,
			matchId: match.id,
		});

		return this.completeResolvedNew(match, closetItemId, prepared.crop_blur_hash, false);
	}

	private async completeResolvedNew(
		match: ClosetItemMatchWithOutfit,
		closetItemId: string,
		blurHash: string | null,
		enqueueRepair = true
	): Promise<ResolveClosetMatchResult> {
		const item = clothingItemFromMatch(match);
		await this.closet.linkClosetItemToOutfit({
			outfitId: match.outfit_id,
			closetItemId,
			boundingBox: match.bounding_box,
			confidence: extractionConfidence(item.confidence),
			blurHash,
		});

		this.log.info('outfit_identity_resolve_new', {
			match_id: match.id,
			outfit_id: match.outfit_id,
			closet_item_id: closetItemId,
		});
		await this.notifyCatalog(match.user_id, match.outfit_id, [
			{
				closet_item_id: closetItemId,
				identity_status: 'created',
				category: item.category,
				subcategory: item.subcategory,
			},
		]);
		if (enqueueRepair) {
			await this.enqueueVectorRepair({
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

	private async enqueueVectorRepair(
		job: ClosetVectorRepairJob | ClosetVectorBackfillJob
	): Promise<void> {
		if (!this.repairQueue) return;
		try {
			await this.repairQueue.send(job);
		} catch (err) {
			this.log.warn(
				'closet_vector_repair_enqueue_failed',
				{
					closet_item_id:
						'closetItemId' in job ? job.closetItemId : undefined,
					match_id: 'matchId' in job ? job.matchId : undefined,
				},
				err
			);
		}
	}

	private async preparedForResolve(
		match: ClosetItemMatchWithOutfit,
		signal?: AbortSignal
	): Promise<PreparedClosetCrop> {
		const fromProbe = preparedFromProbeEmbed(match.probe_embed, match.outfit_image_key);
		if (fromProbe) return fromProbe;
		return this.identity.prepareClosetCrop({
			imageKey: match.outfit_image_key,
			boundingBox: match.bounding_box,
			signal,
		});
	}

	private async persistAsk(
		params: {
			userId: string;
			outfitId: string;
			item: ClothingItem;
			replaceMatchId?: string;
		},
		decision: Extract<IdentityDecision, { action: 'ask' }>,
		prepared: PreparedClosetCrop
	): Promise<ProcessedOutfitItem> {
		const probeEmbed = closetMatchProbeFromPrepared(prepared);
		let matchId = params.replaceMatchId;
		if (matchId) {
			const updated = await this.closet.updatePendingMatch(params.userId, matchId, {
				candidateClosetItemId: decision.candidateClosetItemId,
				score: decision.identityScore,
				cosine: decision.cosine,
				colorDistance: decision.colorDistance,
				probeEmbed,
			});
			if (!updated) {
				throw new ClosetMatchResolvedError(matchId, 'resolved');
			}
		} else {
			const match = await this.closet.createPendingMatch({
				userId: params.userId,
				outfitId: params.outfitId,
				candidateClosetItemId: decision.candidateClosetItemId,
				boundingBox: params.item.bounding_box,
				confidence: extractionConfidence(params.item.confidence),
				extractSnapshot: extractSnapshot(params.item),
				score: decision.identityScore,
				cosine: decision.cosine,
				colorDistance: decision.colorDistance,
				probeEmbed,
			});
			matchId = match.id;
		}

		try {
			await this.closet.touchMatchAsk(params.userId);
		} catch (err) {
			this.log.warn('closet_match_touch_ask_failed', { user_id: params.userId, match_id: matchId }, err);
		}

		this.log.info('outfit_identity_ask', {
			outfit_id: params.outfitId,
			match_id: matchId,
			candidate_closet_item_id: decision.candidateClosetItemId,
			identity_score: decision.identityScore,
			label: params.item.label,
		});
		return {
			...params.item,
			closet_item_id: null,
			is_new_closet_item: false,
			identity_status: 'ask',
			identity_reason: 'ask',
			match_id: matchId,
			candidate_closet_item_id: decision.candidateClosetItemId,
			identity_score: decision.identityScore,
		};
	}

	private async scheduleDigest(userId: string): Promise<void> {
		if (!this.digest) return;
		try {
			await this.digest.schedule(userId);
		} catch (err) {
			this.log.warn('closet_match_digest_enqueue_failed', { user_id: userId }, err);
		}
	}

	private async notifyCatalog(
		userId: string,
		outfitId: string,
		items: readonly ClosetCatalogNotifyItem[]
	): Promise<void> {
		if (!this.catalog) return;
		try {
			await this.catalog.notify({ userId, outfitId, items });
		} catch (err) {
			this.log.warn(
				'closet_catalog_broadcast_failed',
				{ user_id: userId, outfit_id: outfitId },
				err
			);
		}
	}
}

export const createOutfitIdentityProcessor = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'outfit_identity' });
	return new OutfitIdentityProcessor(
		createOutfitExtractionService(envBindings, logger),
		createIdentityService(envBindings, logger),
		createClosetDB(envBindings.GOSTYLENS_DB),
		logger,
		DEFAULT_WAIT,
		createClosetMatchDigestScheduler(envBindings, logger),
		createClosetCatalogNotifier(createRealtimeService(), logger),
		envBindings.CLOSET_IDENTITY_QUEUE
	);
};

function failedItem(
	item: ClothingItem,
	reason: IdentityCreateReason,
	identityScore?: number | null
): ProcessedOutfitItem {
	return {
		...item,
		closet_item_id: null,
		is_new_closet_item: false,
		identity_status: 'failed',
		identity_reason: reason,
		match_id: null,
		candidate_closet_item_id: null,
		identity_score: identityScore ?? null,
	};
}

function clothingItemFromMatch(match: ClosetItemMatchWithOutfit): ClothingItem {
	return {
		label: match.extract_snapshot.label,
		category: (match.extract_snapshot.category as ClothingItemCategory) || ClothingItemCategory.ACCESSORY,
		subcategory:
			(match.extract_snapshot.subcategory as ClothingItemSubcategory) || ClothingItemSubcategory.OTHER,
		color: match.extract_snapshot.color,
		pattern: (match.extract_snapshot.pattern as ClothingItemPattern) || ClothingItemPattern.OTHER,
		style_tags: match.extract_snapshot.styleTags,
		confidence: (match.confidence as ExtractionConfidence) || ExtractionConfidence.MEDIUM,
		bounding_box: match.bounding_box,
	};
}

function extractSnapshot(item: ClothingItem): ClosetItemExtractSnapshot {
	return {
		label: item.label,
		category: item.category,
		subcategory: item.subcategory,
		color: item.color,
		pattern: item.pattern,
		styleTags: item.style_tags || [],
	};
}

export { closetMatchProbeFromPrepared, preparedFromProbeEmbed } from './probeEmbed';

function extractionConfidence(confidence: ClothingItem['confidence']): 'high' | 'medium' | 'low' {
	if (confidence === ExtractionConfidence.HIGH) return 'high';
	if (confidence === ExtractionConfidence.LOW) return 'low';
	return 'medium';
}
