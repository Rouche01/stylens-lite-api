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
import { createPushService } from '../push.svc';
import { createOutfitExtractionService, OutfitExtractionService } from '../outfit_extraction.svc';
import {
	createIdentityService,
	IdentityService,
	VECTOR_VISIBLE_POLL_MS,
	VECTOR_VISIBLE_TIMEOUT_MS,
	type PreparedClosetCrop,
	type QueryClosetCropMatch,
} from './identity.svc';
import { isIdentityMatch } from './cropColor';
import { closetItemVectorId } from './vectorize.store';

export type OutfitIdentityExtractor = Pick<OutfitExtractionService, 'extractOutfitItems'>;
export type OutfitIdentityQueries = Pick<
	IdentityService,
	| 'prepareClosetCrop'
	| 'queryPreparedCrop'
	| 'upsertPreparedCrop'
	| 'waitUntilVectorVisible'
	| 'deleteVector'
>;
export type OutfitIdentityStore = Pick<
	ClosetDB,
	| 'createOutfit'
	| 'createClosetItem'
	| 'linkClosetItemToOutfit'
	| 'createPendingMatch'
	| 'findClosetItemForPhotoCrop'
	| 'getClosetItemSummary'
	| 'tryAcquireIdentityLock'
	| 'releaseIdentityLock'
	| 'getMatchWithOutfit'
	| 'markMatchResolved'
	| 'updatePendingMatch'
>;

export type ClosetMatchNotifier = {
	notifyPendingMatch(params: {
		userId: string;
		matchId: string;
		candidateClosetItemId: string;
		outfitId: string;
		label: string;
	}): Promise<void>;
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
	timeoutMs: number;
	pollMs: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

export type ProcessOutfitImageParams = {
	userId: string;
	imageUrl: string;
	imageKey: string;
	signal?: AbortSignal;
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
	timeoutMs: VECTOR_VISIBLE_TIMEOUT_MS,
	pollMs: VECTOR_VISIBLE_POLL_MS,
	now: Date.now,
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

export function closetMatchNotification(params: {
	matchId: string;
	candidateClosetItemId: string;
	outfitId: string;
	label: string;
}): { title: string; body: string; data: Record<string, string> } {
	const label = params.label.trim() || 'item';
	return {
		title: 'Is this the same item?',
		body: `Is this the same ${label}?`,
		data: {
			type: 'closet_match',
			match_id: params.matchId,
			candidate_closet_item_id: params.candidateClosetItemId,
			outfit_id: params.outfitId,
		},
	};
}

export class OutfitIdentityProcessor {
	constructor(
		private extract: OutfitIdentityExtractor,
		private identity: OutfitIdentityQueries,
		private closet: OutfitIdentityStore,
		private log: Logger,
		private wait: IdentityWait = DEFAULT_WAIT,
		private notify?: ClosetMatchNotifier
	) {}

	async process(params: ProcessOutfitImageParams): Promise<ProcessOutfitImageResult | null> {
		const extracted = await this.extract.extractOutfitItems({
			imageUrl: params.imageUrl,
			signal: params.signal,
		});
		if (!extracted) {
			return null;
		}

		const jobId = crypto.randomUUID();
		const acquired = await this.acquireLock(params.userId, jobId);
		if (!acquired) {
			throw new IdentityBusyError(params.userId);
		}

		try {
			const outfit = await this.closet.createOutfit(params.userId, params.imageUrl, params.imageKey);
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
			throw new ClosetMatchResolvedError(params.matchId, match.status);
		}

		const jobId = crypto.randomUUID();
		const acquired = await this.acquireLock(params.userId, jobId);
		if (!acquired) {
			throw new IdentityBusyError(params.userId);
		}

		try {
			const latest = await this.closet.getMatchWithOutfit(params.userId, params.matchId);
			if (!latest) {
				throw new ClosetMatchNotFoundError(params.matchId);
			}
			if (latest.status !== 'pending') {
				throw new ClosetMatchResolvedError(params.matchId, latest.status);
			}

			if (params.decision === 'same') {
				return this.resolveSame(latest);
			}
			return this.resolveNew(latest, params.signal);
		} finally {
			await this.closet.releaseIdentityLock(params.userId, jobId);
		}
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
			return this.persistAsk(params, decision);
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
		const vectorId = closetItemVectorId(closetItemId);
		try {
			await this.identity.upsertPreparedCrop(prepared, {
				userId: params.userId,
				category: params.item.category,
				closetItemId,
			});
		} catch (err) {
			this.log.warn(
				'outfit_identity_upsert_failed',
				{ closet_item_id: closetItemId, outfit_id: params.outfitId, label: params.item.label },
				err
			);
			return failedItem(params.item, 'upsert_failed', decision.identityScore);
		}

		const visible = await this.identity.waitUntilVectorVisible(vectorId, this.wait);
		if (!visible) {
			await this.identity.deleteVector(vectorId);
			this.log.warn('outfit_identity_visibility_timeout', {
				closet_item_id: closetItemId,
				vector_id: vectorId,
			});
			return failedItem(params.item, 'visibility_timeout', decision.identityScore);
		}

		let commit: CommitDecision = { action: 'commit' };
		try {
			const requery = await this.identity.queryPreparedCrop(prepared, {
				imageKey: params.imageKey,
				boundingBox: params.item.bounding_box,
				userId: params.userId,
				category: params.item.category,
			});
			commit = decideCommitAfterRequery(
				closetItemId,
				requery.neighbors,
				params.ignoreClosetItemIds
			);
		} catch (err) {
			this.log.warn('outfit_identity_requery_failed', { closet_item_id: closetItemId }, err);
		}

		if (commit.action === 'ask') {
			await this.identity.deleteVector(vectorId);
			return this.persistAsk(params, commit);
		}

		if (commit.action === 'yield') {
			await this.identity.deleteVector(vectorId);
			const winner = await this.waitForClosetItem(commit.winnerId);
			if (!winner) {
				this.log.warn('outfit_identity_race_lost', {
					closet_item_id: closetItemId,
					winner_id: commit.winnerId,
				});
				return failedItem(params.item, 'race_lost', commit.identityScore);
			}
			return this.persistAsk(params, {
				action: 'ask',
				candidateClosetItemId: winner.id,
				identityScore: commit.identityScore,
				cosine: commit.cosine,
				colorDistance: commit.colorDistance,
			});
		}

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
			await this.identity.deleteVector(vectorId);
			this.log.warn(
				'outfit_identity_d1_failed',
				{ closet_item_id: closetItemId, outfit_id: params.outfitId },
				err
			);
			return failedItem(params.item, 'd1_failed', decision.identityScore);
		}
	}

	private async resolveSame(match: ClosetItemMatchWithOutfit): Promise<ResolveClosetMatchResult> {
		const candidate = await this.closet.getClosetItemSummary(match.candidate_closet_item_id);
		if (!candidate) {
			throw new ClosetMatchNotFoundError(match.id);
		}

		await this.closet.linkClosetItemToOutfit({
			outfitId: match.outfit_id,
			closetItemId: match.candidate_closet_item_id,
			boundingBox: match.bounding_box,
			confidence: extractionConfidence(match.confidence as ExtractionConfidence),
		});
		const marked = await this.closet.markMatchResolved(match.user_id, match.id, 'same');
		if (!marked) {
			throw new ClosetMatchResolvedError(match.id, 'resolved');
		}

		this.log.info('outfit_identity_resolve_same', {
			match_id: match.id,
			outfit_id: match.outfit_id,
			closet_item_id: match.candidate_closet_item_id,
		});
		return {
			decision: 'same',
			match_id: match.id,
			closet_item_id: match.candidate_closet_item_id,
			candidate_closet_item_id: match.candidate_closet_item_id,
			identity_status: 'created',
			identity_reason: 'same',
			identity_score: match.score,
		};
	}

	private async resolveNew(
		match: ClosetItemMatchWithOutfit,
		signal?: AbortSignal
	): Promise<ResolveClosetMatchResult> {
		const item = clothingItemFromMatch(match);
		let prepared: PreparedClosetCrop;
		try {
			prepared = await this.identity.prepareClosetCrop({
				imageKey: match.outfit_image_key,
				boundingBox: match.bounding_box,
				signal,
			});
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

		const processed = await this.commitNewItem(
			{
				userId: match.user_id,
				imageKey: match.outfit_image_key,
				outfitId: match.outfit_id,
				item,
				ignoreClosetItemIds: [match.candidate_closet_item_id],
				replaceMatchId: match.id,
			},
			prepared,
			{ action: 'create', reason: 'no_neighbor' }
		);

		if (processed.identity_status === 'created' && processed.closet_item_id) {
			const marked = await this.closet.markMatchResolved(match.user_id, match.id, 'new');
			if (!marked) {
				throw new ClosetMatchResolvedError(match.id, 'resolved');
			}
			this.log.info('outfit_identity_resolve_new', {
				match_id: match.id,
				outfit_id: match.outfit_id,
				closet_item_id: processed.closet_item_id,
			});
			return {
				decision: 'new',
				match_id: match.id,
				closet_item_id: processed.closet_item_id,
				candidate_closet_item_id: match.candidate_closet_item_id,
				identity_status: 'created',
				identity_reason: processed.identity_reason,
				identity_score: processed.identity_score,
			};
		}

		if (processed.identity_status === 'ask') {
			return {
				decision: 'ask',
				match_id: processed.match_id ?? match.id,
				closet_item_id: null,
				candidate_closet_item_id: processed.candidate_closet_item_id,
				identity_status: 'ask',
				identity_reason: 'ask',
				identity_score: processed.identity_score,
			};
		}

		return {
			decision: 'new',
			match_id: match.id,
			closet_item_id: null,
			candidate_closet_item_id: match.candidate_closet_item_id,
			identity_status: 'failed',
			identity_reason: processed.identity_reason === 'ask' ? 'identity_error' : processed.identity_reason,
			identity_score: processed.identity_score,
		};
	}

	private async persistAsk(
		params: {
			userId: string;
			outfitId: string;
			item: ClothingItem;
			replaceMatchId?: string;
		},
		decision: Extract<IdentityDecision, { action: 'ask' }>
	): Promise<ProcessedOutfitItem> {
		let matchId = params.replaceMatchId;
		if (matchId) {
			const updated = await this.closet.updatePendingMatch(params.userId, matchId, {
				candidateClosetItemId: decision.candidateClosetItemId,
				score: decision.identityScore,
				cosine: decision.cosine,
				colorDistance: decision.colorDistance,
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
			});
			matchId = match.id;
		}

		this.log.info('outfit_identity_ask', {
			outfit_id: params.outfitId,
			match_id: matchId,
			candidate_closet_item_id: decision.candidateClosetItemId,
			identity_score: decision.identityScore,
			label: params.item.label,
		});
		await this.notifyAsk({
			userId: params.userId,
			matchId,
			candidateClosetItemId: decision.candidateClosetItemId,
			outfitId: params.outfitId,
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

	private async notifyAsk(params: {
		userId: string;
		matchId: string;
		candidateClosetItemId: string;
		outfitId: string;
		label: string;
	}): Promise<void> {
		if (!this.notify) return;
		try {
			await this.notify.notifyPendingMatch(params);
		} catch (err) {
			this.log.warn('closet_match_push_failed', { match_id: params.matchId, user_id: params.userId }, err);
		}
	}

	private async waitForClosetItem(itemId: string): Promise<{ id: string } | null> {
		const deadline = this.wait.now() + this.wait.timeoutMs;
		for (;;) {
			const item = await this.closet.getClosetItemSummary(itemId);
			if (item) return item;
			if (this.wait.now() >= deadline) return null;
			const wait = Math.min(this.wait.pollMs, Math.max(0, deadline - this.wait.now()));
			if (wait <= 0) return null;
			await this.wait.sleep(wait);
		}
	}
}

export const createOutfitIdentityProcessor = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'outfit_identity' });
	const push = createPushService(envBindings, logger);
	const notify: ClosetMatchNotifier = {
		async notifyPendingMatch(params) {
			const message = closetMatchNotification(params);
			try {
				await push.sendPushNotification(params.userId, message.title, message.body, message.data);
			} catch (err) {
				logger.warn(
					'closet_match_push_failed',
					{ match_id: params.matchId, user_id: params.userId },
					err
				);
			}
		},
	};
	return new OutfitIdentityProcessor(
		createOutfitExtractionService(envBindings, logger),
		createIdentityService(envBindings, logger),
		createClosetDB(envBindings.GOSTYLENS_DB),
		logger,
		DEFAULT_WAIT,
		notify
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

function extractionConfidence(confidence: ClothingItem['confidence']): 'high' | 'medium' | 'low' {
	if (confidence === ExtractionConfidence.HIGH) return 'high';
	if (confidence === ExtractionConfidence.LOW) return 'low';
	return 'medium';
}
