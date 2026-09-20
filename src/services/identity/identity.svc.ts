import { signDownloadUrlForKey } from '../../utils/assets.utils';
import { percentBoxToTrim, type PercentBox } from '../../utils/bounding_box';
import { cropJpegWithTrim, orientImageJpeg } from '../../utils/cf_images.utils';
import { getImageDimensions } from '../../utils/image.utils';
import { Logger, createLogger } from '../../utils/logger.utils';
import { createClosetDB } from '../../db';
import { ClosetDB } from '../../db/closet';
import {
	IdentityEmbedError,
	IDENTITY_ENCODER,
	VECTORIZE_INDEX_DIMENSIONS,
	type ImageEmbedProvider,
} from './embed.types';
import { createImageEmbedProvider } from './embed.provider';
import { resolveIdentitySlot } from './slot';
import {
	colorSignatureFromMetadata,
	colorSignatureToMetadata,
	cropColorDistance,
	extractCropVisuals,
	identityScore,
	isIdentityMatch,
	type CropColorSignature,
} from './cropColor';
import {
	ClosetVectorMatch,
	ClosetVectorStore,
	ClosetVectorUpsertResult,
	ClosetItemVectorMetadata,
	buildClosetVectorMetadata,
	closetItemIdFromVectorId,
	resolveClosetVectorId,
} from './vectorize.store';

export type EmbedClosetCropParams = {
	imageKey: string;
	boundingBox: PercentBox;
	signal?: AbortSignal;
};

export type EmbedClosetCropResult = {
	model: string;
	dimensions: number;
	index_dimensions: number;
	matches_index: boolean;
	vector_preview: number[];
	crop_image_key: string;
	crop_image_url: string;
	crop_width: number;
	crop_height: number;
	source_image_key: string;
	crop_color: CropColorSignature | null;
	crop_blur_hash: string | null;
};

export type UpsertClosetCropParams = EmbedClosetCropParams & {
	id?: string;
	userId: string;
	category: string;
	closetItemId?: string;
};

export type UpsertClosetCropResult = EmbedClosetCropResult & {
	vector_id: string;
	metadata: ClosetItemVectorMetadata;
	mutation: ClosetVectorUpsertResult;
};

export type QueryClosetCropParams = EmbedClosetCropParams & {
	userId?: string;
	category?: string;
	topK?: number;
};

export type QueryClosetCropMatch = ClosetVectorMatch & {
	d1_closet_item_id: string | null;
	d1_label: string | null;
	color_distance: number | null;
	identity_score: number;
};

export type QueryClosetCropResult = EmbedClosetCropResult & {
	matches: QueryClosetCropMatch[];
	match_count: number;
	neighbors: QueryClosetCropMatch[];
	neighbor_count: number;
	probe_d1_closet_item_id: string | null;
	probe_d1_label: string | null;
};

export type PreparedClosetCrop = EmbedClosetCropResult & { vector: number[] };

type EmbeddedCrop = PreparedClosetCrop;

export const VECTOR_VISIBLE_TIMEOUT_MS = 20_000;
export const VECTOR_VISIBLE_POLL_MS = 500;

const VECTOR_PREVIEW_LENGTH = 8;

export class IdentityService {
	constructor(
		private bucket: R2Bucket,
		private images: ImagesBinding,
		private embedder: ImageEmbedProvider,
		private vectors: ClosetVectorStore | undefined,
		private closet: ClosetDB,
		private log: Logger
	) {}

	async embedClosetCrop(params: EmbedClosetCropParams): Promise<EmbedClosetCropResult> {
		const { vector: _vector, ...result } = await this.embedCrop(params);
		return result;
	}

	async prepareClosetCrop(params: EmbedClosetCropParams): Promise<PreparedClosetCrop> {
		return this.embedCrop(params);
	}

	async upsertClosetCrop(params: UpsertClosetCropParams): Promise<UpsertClosetCropResult> {
		const embedded = await this.embedCrop(params);
		const linked = params.closetItemId?.trim()
			? null
			: await this.closet.findClosetItemForPhotoCrop(params.userId, params.imageKey, params.boundingBox);
		const closetItemId = params.closetItemId?.trim() || linked?.id;
		return this.upsertPreparedCrop(embedded, {
			id: params.id,
			userId: params.userId,
			category: params.category,
			closetItemId,
		});
	}

	async upsertPreparedCrop(
		embedded: PreparedClosetCrop,
		params: { id?: string; userId: string; category: string; closetItemId?: string }
	): Promise<UpsertClosetCropResult> {
		const closetItemId = params.closetItemId?.trim();
		const vectorId = resolveClosetVectorId({
			id: params.id,
			closetItemId,
		});
		const metadata = buildClosetVectorMetadata({
			userId: params.userId,
			category: params.category,
			closetItemId: closetItemIdFromVectorId(vectorId, closetItemId),
			color: embedded.crop_color ? colorSignatureToMetadata(embedded.crop_color) : undefined,
		});
		const mutation = await this.requireVectors().upsert(vectorId, embedded.vector, metadata);
		this.log.info('identity_vector_upserted', {
			vector_id: vectorId,
			user_id: metadata.user_id,
			slot: metadata.slot,
			encoder: metadata.encoder,
			category: metadata.category,
			closet_item_id: metadata.closet_item_id,
			mutation_count: mutation.count,
		});
		const { vector: _vector, ...preview } = embedded;
		return { ...preview, vector_id: vectorId, metadata, mutation };
	}

	async queryClosetCrop(params: QueryClosetCropParams): Promise<QueryClosetCropResult> {
		const embedded = await this.embedCrop(params);
		return this.queryPreparedCrop(embedded, params);
	}

	async queryPreparedCrop(
		embedded: PreparedClosetCrop,
		params: QueryClosetCropParams
	): Promise<QueryClosetCropResult> {
		const probe = params.userId
			? await this.closet.findClosetItemForPhotoCrop(params.userId, params.imageKey, params.boundingBox)
			: null;
		const slot = resolveIdentitySlot(params.category) ?? resolveIdentitySlot(probe?.category);
		const queried = await this.requireVectors().querySimilar(embedded.vector, {
			topK: params.topK,
			userId: params.userId,
			slot,
			encoder: IDENTITY_ENCODER,
		});
		const neighbors = (await this.hydrateD1Matches(queried.matches, embedded.crop_color)).sort(
			(a, b) => b.identity_score - a.identity_score
		);
		const matches = neighbors.filter((match) => isIdentityMatch(match.identity_score));
		this.log.info('identity_vector_queried', {
			match_count: matches.length,
			neighbor_count: queried.count,
			top_score: neighbors[0]?.score,
			top_identity_score: neighbors[0]?.identity_score,
			top_color_distance: neighbors[0]?.color_distance,
			top_closet_item_id: neighbors[0]?.closet_item_id,
			top_d1_closet_item_id: neighbors[0]?.d1_closet_item_id,
			probe_d1_closet_item_id: probe?.id,
			user_id: params.userId,
			slot,
			category: params.category,
		});
		const { vector: _vector, ...preview } = embedded;
		return {
			...preview,
			matches,
			match_count: matches.length,
			neighbors,
			neighbor_count: neighbors.length,
			probe_d1_closet_item_id: probe?.id ?? null,
			probe_d1_label: probe?.label ?? null,
		};
	}

	async waitUntilVectorVisible(
		vectorId: string,
		opts: {
			timeoutMs?: number;
			pollMs?: number;
			now?: () => number;
			sleep?: (ms: number) => Promise<void>;
		} = {}
	): Promise<boolean> {
		const timeoutMs = opts.timeoutMs ?? VECTOR_VISIBLE_TIMEOUT_MS;
		const pollMs = opts.pollMs ?? VECTOR_VISIBLE_POLL_MS;
		const now = opts.now ?? Date.now;
		const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		const deadline = now() + timeoutMs;
		for (;;) {
			const found = await this.requireVectors().getByIds([vectorId]);
			if (found.length > 0) {
				return true;
			}
			if (now() >= deadline) {
				return false;
			}
			const wait = Math.min(pollMs, Math.max(0, deadline - now()));
			if (wait <= 0) {
				return false;
			}
			await sleep(wait);
		}
	}

	async getVectorsByIds(ids: string[]): Promise<Array<{ id: string }>> {
		if (ids.length === 0) return [];
		return this.requireVectors().getByIds(ids);
	}

	async deleteVector(vectorId: string): Promise<void> {
		try {
			await this.requireVectors().deleteByIds([vectorId]);
			this.log.info('identity_vector_deleted', { vector_id: vectorId });
		} catch (err) {
			this.log.warn('identity_vector_delete_failed', { vector_id: vectorId }, err);
		}
	}

	private async hydrateD1Matches(
		matches: ClosetVectorMatch[],
		probeColor: CropColorSignature | null
	): Promise<QueryClosetCropMatch[]> {
		return Promise.all(
			matches.map(async (match) => {
				const candidate = match.closet_item_id?.startsWith('scratch:') ? '' : match.closet_item_id;
				const item = candidate ? await this.closet.getClosetItemSummary(candidate) : null;
				const storedColor = colorSignatureFromMetadata(match.metadata);
				const colorDistance =
					probeColor && storedColor ? cropColorDistance(probeColor, storedColor) : null;
				return {
					...match,
					d1_closet_item_id: item?.id ?? null,
					d1_label: item?.label ?? null,
					color_distance: colorDistance,
					identity_score: identityScore(match.score, colorDistance),
				};
			})
		);
	}

	private requireVectors(): ClosetVectorStore {
		if (!this.vectors) {
			throw new IdentityEmbedError('CLOSET_ITEMS Vectorize binding is not configured', 500);
		}
		return this.vectors;
	}

	private async embedCrop(params: EmbedClosetCropParams): Promise<EmbeddedCrop> {
		const { imageKey, boundingBox, signal } = params;
		const log = this.log.child({ image_key: imageKey, provider: this.embedder.name });

		const object = await getR2Object(this.bucket, imageKey);
		if (!object?.body) {
			throw new IdentityEmbedError(`Outfit image not found in R2: ${imageKey}`, 404);
		}

		const sourceBytes = await object.arrayBuffer();
		const oriented = await orientImageJpeg(this.images, sourceBytes);
		const dims = await getImageDimensions(oriented);
		const trim = percentBoxToTrim(boundingBox, dims.width, dims.height);
		const cropJpeg = await cropJpegWithTrim(this.images, oriented, trim);
		const cropDims = await getImageDimensions(cropJpeg);

		const cropImageKey = `identity/scratch/crop-${crypto.randomUUID()}.jpg`;
		try {
			await this.bucket.put(cropImageKey, cropJpeg, {
				httpMetadata: { contentType: 'image/jpeg' },
			});
		} catch (err) {
			throw r2BindError('put', cropImageKey, err);
		}
		const cropImageUrl = await signDownloadUrlForKey(cropImageKey);
		let cropColor: CropColorSignature | null = null;
		let cropBlurHash: string | null = null;
		try {
			const visuals = await extractCropVisuals(this.images, cropJpeg);
			cropColor = visuals.color;
			cropBlurHash = visuals.blurHash;
		} catch (err) {
			log.warn('identity_crop_color_failed', {
				error: err instanceof Error ? err.message : 'unknown',
			});
		}

		log.info('identity_embed_start', {
			crop_image_key: cropImageKey,
			crop_color_h: cropColor?.h,
			crop_color_s: cropColor?.s,
			crop_color_l: cropColor?.l,
		});

		const embedded = await this.embedder.embedImage({
			imageUrl: cropImageUrl,
			imageBytes: cropJpeg,
			contentType: 'image/jpeg',
			signal,
		});

		return {
			model: embedded.model,
			dimensions: embedded.dimensions,
			index_dimensions: VECTORIZE_INDEX_DIMENSIONS,
			matches_index: embedded.dimensions === VECTORIZE_INDEX_DIMENSIONS,
			vector_preview: embedded.vector.slice(0, VECTOR_PREVIEW_LENGTH),
			crop_image_key: cropImageKey,
			crop_image_url: cropImageUrl,
			crop_width: cropDims.width,
			crop_height: cropDims.height,
			source_image_key: imageKey,
			crop_color: cropColor,
			crop_blur_hash: cropBlurHash,
			vector: embedded.vector,
		};
	}
}

type IdentityEnv = Env & {
	JINA_API_KEY?: string;
	REPLICATE_API_TOKEN?: string;
	CLOSET_EMBED_MODEL?: string;
	CLOSET_EMBED_PROVIDER?: string;
};

export const createIdentityService = (envBindings: Env, log?: Logger) => {
	const env = envBindings as IdentityEnv;
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'identity' });
	const index = envBindings.CLOSET_ITEMS;
	return new IdentityService(
		envBindings.OUTFIT_PHOTOS_BUCKET,
		envBindings.IMAGES,
		createImageEmbedProvider(env),
		index ? new ClosetVectorStore(index) : undefined,
		createClosetDB(envBindings.GOSTYLENS_DB),
		logger
	);
};

async function getR2Object(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await bucket.get(key);
		} catch (err) {
			lastError = err;
			if (!isTransientR2Error(err) || attempt === 2) {
				throw r2BindError('get', key, err);
			}
			await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
		}
	}
	throw r2BindError('get', key, lastError);
}

function isTransientR2Error(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /Unspecified error|CF-R2-Error/i.test(message);
}

function r2BindError(op: 'get' | 'put', key: string, err: unknown): IdentityEmbedError {
	const message = err instanceof Error ? err.message : 'unknown';
	return new IdentityEmbedError(
		`R2 ${op} failed for ${key} (${message}). Retry the request; if it keeps failing, restart wrangler dev — remote R2 bindings flake after a long session.`,
		502
	);
}
