/** Vectorize index for DINOv3 CLS. Recreate the index if the embedder returns a different length. */
export const VECTORIZE_INDEX_DIMENSIONS = 1024;

/** Pin in Vectorize metadata. Never mix encoder generations in one query. */
export const IDENTITY_ENCODER = 'dinov3-cls-v1';

export const DEFAULT_CLOSET_EMBED_PROVIDER = 'dinov3';
export const DEFAULT_JINA_EMBED_MODEL = 'jina-clip-v2';
export const DEFAULT_DINO_EMBED_MODEL = 'noah-bjorner/dinov3-vit-large-distilled';
/** Community Cog version; `/v1/models/{owner}/{name}/predictions` is official models only. */
export const DEFAULT_DINO_EMBED_VERSION = '6b3d9f86b7c525271f4bdc29b50baa1cdb987faa0f67161499a22ea603dbd3a7';
/** @deprecated Use DEFAULT_DINO_EMBED_MODEL. */
export const DEFAULT_CLOSET_EMBED_MODEL = DEFAULT_DINO_EMBED_MODEL;

export class IdentityEmbedError extends Error {
	constructor(
		message: string,
		public readonly status: number = 502
	) {
		super(message);
		this.name = 'IdentityEmbedError';
	}
}

export type ImageEmbedResult = {
	model: string;
	dimensions: number;
	vector: number[];
};

export type EmbedImageInput = {
	imageUrl: string;
	imageBytes: ArrayBuffer;
	contentType?: string;
	signal?: AbortSignal;
};

export type ImageEmbedProvider = {
	readonly name: string;
	embedImage(input: EmbedImageInput): Promise<ImageEmbedResult>;
};
