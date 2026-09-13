export { createIdentityService, IdentityService } from './identity.svc';
export {
	OutfitIdentityProcessor,
	createOutfitIdentityProcessor,
	decideIdentityFromNeighbors,
	decideCommitAfterRequery,
	candidateClosetItemId,
	shouldQueryIdentity,
	IdentityBusyError,
} from './processOutfitImage';
export type {
	ProcessOutfitImageParams,
	ProcessOutfitImageResult,
	ProcessedOutfitItem,
	IdentityDecision,
	CommitDecision,
} from './processOutfitImage';
export type {
	EmbedClosetCropParams,
	EmbedClosetCropResult,
	UpsertClosetCropParams,
	UpsertClosetCropResult,
	QueryClosetCropParams,
	QueryClosetCropResult,
	QueryClosetCropMatch,
	PreparedClosetCrop,
} from './identity.svc';
export {
	VECTOR_VISIBLE_TIMEOUT_MS,
	VECTOR_VISIBLE_POLL_MS,
} from './identity.svc';
export {
	IdentityEmbedError,
	JinaClipEmbedProvider,
	DinoV3ReplicateEmbedProvider,
	parseJinaEmbedding,
	parseDinoClsEmbedding,
	createImageEmbedProvider,
	VECTORIZE_INDEX_DIMENSIONS,
	DEFAULT_CLOSET_EMBED_MODEL,
	DEFAULT_CLOSET_EMBED_PROVIDER,
	DEFAULT_DINO_EMBED_MODEL,
	DEFAULT_DINO_EMBED_VERSION,
	DEFAULT_JINA_EMBED_MODEL,
	IDENTITY_ENCODER,
} from './embed.provider';
export {
	ClosetVectorStore,
	closetItemVectorId,
	resolveClosetVectorId,
	buildClosetQueryFilter,
	buildClosetVectorMetadata,
	assertEmbeddingDimensions,
	clampTopK,
} from './vectorize.store';
export type { ClosetItemVectorMetadata, ClosetVectorMatch } from './vectorize.store';
export { resolveIdentitySlot, requireIdentitySlot } from './slot';
export type { IdentitySlot } from './slot';
export {
	rgbaToColorSignature,
	cropColorDistance,
	identityScore,
	isIdentityMatch,
	IDENTITY_MATCH_MIN,
	colorSignatureToMetadata,
	colorSignatureFromMetadata,
	decodePngRgba,
} from './cropColor';
export type { CropColorSignature } from './cropColor';
