import { createClosetDB } from '../../../db';
import { ClothingItem } from '../../../types';
import { Logger } from '../../../utils/logger.utils';
import { createOutfitExtractionService } from '../../outfit_extraction.svc';
import { createRealtimeService } from '../../realtime.svc';
import type { CropEncoder, PreparedClosetCrop, QueryClosetCropMatch } from '../encode/cropEncoder';
import { closetMatchProbeFromPrepared } from '../encode/probeEmbed';
import {
	decideIdentityFromNeighbors,
	shouldQueryIdentity,
	type IdentityDecision,
} from '../decide/policy';
import {
	SEARCHABLE_GATE_POLL_MS,
	SEARCHABLE_GATE_TIMEOUT_MS,
	awaitPriorCreatesSearchable,
} from '../decide/searchableGate';
import {
	UNINDEXED_PROBE_LIMIT,
	UNINDEXED_PROBE_MAX_AGE_MS,
	mergeIdentityNeighbors,
	scoreUnindexedProbes,
} from '../decide/unindexedFallback';
import { createClosetMatchDigestScheduler } from '../notify/digest';
import { createClosetCatalogNotifier, type ClosetCatalogNotifier } from '../notify/catalogBroadcast';
import { ClosetMatchResolvedError, IdentityBusyError } from './errors';
import { commitNewItem } from './commit';
import { extractSnapshot, extractionConfidence, failedItem } from './helpers';
import { resolveClosetMatch } from './resolveMatch';
import type {
	ClosetMatchDigestScheduler,
	ClosetVectorRepairScheduler,
	IdentityWait,
	OutfitIdentityExtractor,
	OutfitIdentityQueries,
	OutfitIdentityStore,
	OutfitIdentityWriteDeps,
	ProcessOutfitImageParams,
	ProcessOutfitImageResult,
	ProcessedOutfitItem,
	ResolveClosetMatchParams,
	ResolveClosetMatchResult,
} from './types';

export type {
	ClosetMatchDigestScheduler,
	ClosetVectorRepairScheduler,
	IdentityWait,
	OutfitIdentityExtractor,
	OutfitIdentityQueries,
	OutfitIdentityStore,
	ProcessOutfitImageParams,
	ProcessOutfitImageResult,
	ProcessedOutfitItem,
	ResolveClosetMatchParams,
	ResolveClosetMatchResult,
} from './types';

export { IdentityBusyError, ClosetMatchNotFoundError, ClosetMatchResolvedError } from './errors';

const DEFAULT_WAIT: IdentityWait = {
	timeoutMs: SEARCHABLE_GATE_TIMEOUT_MS,
	pollMs: SEARCHABLE_GATE_POLL_MS,
	now: Date.now,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const LOCK_RETRY_COUNT = 8;
const LOCK_RETRY_MS = 250;

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

			await awaitPriorCreatesSearchable({
				userId: params.userId,
				closet: this.closet,
				identity: this.identity,
				wait: this.wait,
				log: this.log,
			});

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

	/**
	 * Resolve a pending ask over HTTP.
	 * Never acquires identity_inflight / never throws IdentityBusyError.
	 * Prefer cached probe_embed; Replicate only if probe missing/stale.
	 * new = CAS + D1 + enqueue index; same = CAS + link.
	 */
	async resolveMatch(params: ResolveClosetMatchParams): Promise<ResolveClosetMatchResult> {
		return resolveClosetMatch(this.writeDeps(), params);
	}

	private writeDeps(): OutfitIdentityWriteDeps {
		return {
			identity: this.identity,
			closet: this.closet,
			log: this.log,
			catalog: this.catalog,
			repairQueue: this.repairQueue,
		};
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

		return commitNewItem(this.writeDeps(), params, prepared, decision);
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
			const localNeighbors = await this.scoreLocalUnindexed(params.userId, prepared, params.item.category);
			const neighbors = mergeIdentityNeighbors(queried.neighbors, localNeighbors);
			return decideIdentityFromNeighbors(neighbors);
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

	private async scoreLocalUnindexed(
		userId: string,
		prepared: PreparedClosetCrop,
		category: string
	): Promise<QueryClosetCropMatch[]> {
		try {
			const probes = await this.closet.listRecentUnindexedProbes(userId, {
				limit: UNINDEXED_PROBE_LIMIT,
				maxAgeMs: UNINDEXED_PROBE_MAX_AGE_MS,
			});
			return scoreUnindexedProbes({ prepared, probes, category });
		} catch (err) {
			this.log.warn('outfit_identity_unindexed_fallback_failed', { user_id: userId }, err);
			return [];
		}
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
}

export function createOutfitIdentityWriter(
	envBindings: Env,
	log: Logger,
	encode: CropEncoder
): OutfitIdentityProcessor {
	const repairQueue: ClosetVectorRepairScheduler = {
		send: (job, options) => envBindings.CLOSET_IDENTITY_QUEUE.send(job, options),
	};
	return new OutfitIdentityProcessor(
		createOutfitExtractionService(envBindings, log),
		encode,
		createClosetDB(envBindings.GOSTYLENS_DB),
		log,
		DEFAULT_WAIT,
		createClosetMatchDigestScheduler(envBindings, log),
		createClosetCatalogNotifier(createRealtimeService(), log),
		repairQueue
	);
}
