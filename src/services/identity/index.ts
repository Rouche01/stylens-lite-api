export { createIdentityService, IdentityService } from './identity.svc';
export type {
	EmbedClosetCropParams,
	EmbedClosetCropResult,
	UpsertClosetCropParams,
	UpsertClosetCropResult,
	QueryClosetCropParams,
	QueryClosetCropResult,
	QueryClosetCropMatch,
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
	colorSignatureToMetadata,
	colorSignatureFromMetadata,
	decodePngRgba,
} from './cropColor';
export type { CropColorSignature } from './cropColor';
