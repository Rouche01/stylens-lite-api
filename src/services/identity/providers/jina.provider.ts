import {
	IdentityEmbedError,
	VECTORIZE_INDEX_DIMENSIONS,
	DEFAULT_JINA_EMBED_MODEL,
	type EmbedImageInput,
	type ImageEmbedProvider,
	type ImageEmbedResult,
} from '../embed.types';

const JINA_EMBEDDINGS_URL = 'https://api.jina.ai/v1/embeddings';

type JinaEmbeddingsResponse = {
	model?: string;
	data?: Array<{ embedding?: unknown }>;
};

export function parseJinaEmbedding(json: unknown, fallbackModel: string): ImageEmbedResult {
	const body = json as JinaEmbeddingsResponse;
	const embedding = body?.data?.[0]?.embedding;
	if (!Array.isArray(embedding) || embedding.length === 0 || embedding.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
		throw new IdentityEmbedError('Jina embeddings response did not include a numeric vector', 502);
	}
	return {
		model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : fallbackModel,
		dimensions: embedding.length,
		vector: embedding as number[],
	};
}

/**
 * Caption-space CLIP. Empirically collapsed two different jackets (~0.85). Keep as opt-in
 * via CLOSET_EMBED_PROVIDER=jina; do not use for closet identity.
 */
export class JinaClipEmbedProvider implements ImageEmbedProvider {
	readonly name = 'jina-clip';

	constructor(
		private apiKey: string,
		private model: string = DEFAULT_JINA_EMBED_MODEL
	) {}

	async embedImage(input: EmbedImageInput): Promise<ImageEmbedResult> {
		const apiKey = this.apiKey?.trim();
		if (!apiKey) {
			throw new IdentityEmbedError('JINA_API_KEY is not set', 500);
		}

		const response = await fetch(JINA_EMBEDDINGS_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: this.model,
				input: [{ image: input.imageUrl }],
				dimensions: VECTORIZE_INDEX_DIMENSIONS,
			}),
			signal: input.signal,
		});

		const json: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new IdentityEmbedError('Jina embeddings unauthorized — check JINA_API_KEY', 502);
			}
			const detail =
				json && typeof json === 'object' && 'detail' in json
					? JSON.stringify((json as { detail: unknown }).detail)
					: json && typeof json === 'object' && 'message' in json
						? String((json as { message: unknown }).message)
						: `Jina embeddings failed (${response.status})`;
			throw new IdentityEmbedError(String(detail), response.status >= 400 ? response.status : 502);
		}

		return parseJinaEmbedding(json, this.model);
	}
}
