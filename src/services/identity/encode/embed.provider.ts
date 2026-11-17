import {
	IdentityEmbedError,
	DEFAULT_CLOSET_EMBED_PROVIDER,
	DEFAULT_JINA_EMBED_MODEL,
	type ImageEmbedProvider,
} from './embed.types';
import { JinaClipEmbedProvider } from './providers/jina.provider';
import { DinoV3ReplicateEmbedProvider, resolveDinoModel } from './providers/replicate.provider';

export {
	IdentityEmbedError,
	VECTORIZE_INDEX_DIMENSIONS,
	DEFAULT_CLOSET_EMBED_PROVIDER,
	DEFAULT_JINA_EMBED_MODEL,
	DEFAULT_DINO_EMBED_MODEL,
	DEFAULT_DINO_EMBED_VERSION,
	DEFAULT_CLOSET_EMBED_MODEL,
	IDENTITY_ENCODER,
} from './embed.types';
export type { ImageEmbedResult, EmbedImageInput, ImageEmbedProvider } from './embed.types';

export { JinaClipEmbedProvider, parseJinaEmbedding } from './providers/jina.provider';
export {
	DinoV3ReplicateEmbedProvider,
	parseDinoClsEmbedding,
	l2Normalize,
	resolveDinoModel,
} from './providers/replicate.provider';

export type ClosetEmbedEnv = {
	CLOSET_EMBED_PROVIDER?: string;
	CLOSET_EMBED_MODEL?: string;
	JINA_API_KEY?: string;
	REPLICATE_API_TOKEN?: string;
};

export function createImageEmbedProvider(env: ClosetEmbedEnv): ImageEmbedProvider {
	const provider = env.CLOSET_EMBED_PROVIDER?.trim().toLowerCase() || DEFAULT_CLOSET_EMBED_PROVIDER;
	if (provider === 'jina') {
		return new JinaClipEmbedProvider(env.JINA_API_KEY ?? '', env.CLOSET_EMBED_MODEL?.trim() || DEFAULT_JINA_EMBED_MODEL);
	}
	if (provider === 'dinov2' || provider === 'dinov3') {
		const ref = resolveDinoModel(env.CLOSET_EMBED_MODEL);
		return new DinoV3ReplicateEmbedProvider(env.REPLICATE_API_TOKEN ?? '', ref.model, ref.version);
	}
	throw new IdentityEmbedError(`Unknown CLOSET_EMBED_PROVIDER: ${provider}`, 500);
}
