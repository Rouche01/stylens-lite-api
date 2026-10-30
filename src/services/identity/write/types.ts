import type { ClosetDB } from '../../../db/closet';
import type { ClothingItem, OutfitExtractionResponse } from '../../../types';
import type { Logger } from '../../../utils/logger.utils';
import type { OutfitExtractionService } from '../../outfit_extraction.svc';
import type { CropEncoder } from '../encode/cropEncoder';
import type { ClosetVectorBackfillJob, ClosetVectorRepairJob } from '../jobs/closetVectorRepair';
import type { ClosetCatalogNotifier } from '../notify/catalogBroadcast';
import type { IdentityCreateReason } from '../decide/policy';

export type OutfitIdentityExtractor = Pick<OutfitExtractionService, 'extractOutfitItems'>;
export type OutfitIdentityQueries = Pick<
	CropEncoder,
	'prepareClosetCrop' | 'queryPreparedCrop' | 'upsertPreparedCrop' | 'getVectorsByIds'
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
	| 'stampVectorIndexedAt'
	| 'listPendingIndexClosetItemIdsForUser'
	| 'listRecentUnindexedProbes'
	| 'listRecentPendingMatchProbes'
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

export type IdentityWait = {
	timeoutMs: number;
	pollMs: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

export type OutfitIdentityWriteDeps = {
	identity: OutfitIdentityQueries;
	closet: OutfitIdentityStore;
	log: Logger;
	catalog?: ClosetCatalogNotifier;
	repairQueue?: ClosetVectorRepairScheduler;
};

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

export type ProcessOutfitImageParams = {
	userId: string;
	imageUrl: string;
	imageKey: string;
	signal?: AbortSignal;
	cachedExtraction?: OutfitExtractionResponse;
	onExtracted?: (extraction: OutfitExtractionResponse) => Promise<void>;
	/** Correlates enqueue → process logs. Minted at enqueue or HTTP extract entry. */
	identityRunId?: string;
};

export type ProcessedOutfitItem = ClothingItem & {
	closet_item_id: string | null;
	is_new_closet_item: boolean;
	identity_status: 'created' | 'ask' | 'failed';
	identity_reason: IdentityCreateReason | 'ask';
	match_id: string | null;
	candidate_closet_item_id: string | null;
	identity_score: number | null;
	/** Raw Vectorize / probe cosine before crop-color blend (eval diagnostics). */
	identity_cosine: number | null;
	/** Crop-color distance used in identityScore; null when color unavailable. */
	identity_color_distance: number | null;
};

export type ProcessOutfitImageResult = {
	outfit_id: string;
	image_key: string;
	extraction: OutfitExtractionResponse;
	items: ProcessedOutfitItem[];
};
