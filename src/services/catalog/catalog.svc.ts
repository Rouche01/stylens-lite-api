import { fetchImageAsArrayBuffer, signDownloadUrlForKey } from '../../utils/assets.utils';
import { CATALOG_BOX_PAD, percentBoxToTrim, type PercentBox } from '../../utils/bounding_box';
import { cropJpegWithTrim } from '../../utils/cf_images.utils';
import { getImageDimensions } from '../../utils/image.utils';
import { Logger, createLogger } from '../../utils/logger.utils';
import { buildCatalogQuery } from './catalog_query';
import {
	CatalogHit,
	CatalogSearchError,
	CatalogSearchProvider,
	createCatalogSearchProvider,
} from './providers';

export type { PercentBox };

export type CatalogSearchFromR2Params = {
	imageKey: string;
	boundingBox: PercentBox;
	color?: string;
	subcategory?: string;
	pattern?: string;
	label?: string;
};

export type CatalogSearchResult = {
	pngBytes: Uint8Array;
	contentType: string;
	imageKey: string;
	cropImageKey: string;
	queryUsed: string;
	provider: string;
	engine: CatalogHit['engine'];
	sourceTitle: string;
	source: string;
	hitImageUrl: string;
};

/**
 * Admin / later queue: crop extract bbox, Lens (then Shopping) for a catalog JPEG.
 */
export class CatalogService {
	constructor(
		private provider: CatalogSearchProvider,
		private bucket: R2Bucket,
		private images: ImagesBinding,
		private log: Logger
	) {}

	async searchFromR2(params: CatalogSearchFromR2Params): Promise<CatalogSearchResult> {
		const { imageKey, boundingBox } = params;
		const queryUsed = buildCatalogQuery({
			color: params.color,
			subcategory: params.subcategory,
			pattern: params.pattern,
			label: params.label,
		});
		const log = this.log.child({
			image_key: imageKey,
			query: queryUsed,
			provider: this.provider.name,
		});

		const object = await this.bucket.get(imageKey);
		if (!object?.body) {
			throw new CatalogSearchError(`Outfit image not found in R2: ${imageKey}`, 404);
		}

		const sourceBytes = await object.arrayBuffer();
		const dims = await getImageDimensions(sourceBytes);
		const trim = percentBoxToTrim(boundingBox, dims.width, dims.height, CATALOG_BOX_PAD);

		let cropJpeg: ArrayBuffer;
		try {
			cropJpeg = await cropJpegWithTrim(this.images, sourceBytes, trim);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'crop failed';
			throw new CatalogSearchError(message, 502);
		}
		const cropImageKey = `catalog/scratch/crop-${crypto.randomUUID()}.jpg`;
		await this.bucket.put(cropImageKey, cropJpeg, {
			httpMetadata: { contentType: 'image/jpeg' },
		});
		const cropUrl = await signDownloadUrlForKey(cropImageKey);

		log.info('catalog_search_start', { crop_image_key: cropImageKey });

		const hits = await this.provider.searchSimilar({ imageUrl: cropUrl, query: queryUsed });
		const hit = hits[0];
		if (!hit) {
			throw new CatalogSearchError(
				`No catalog product image for query "${queryUsed || '(none)'}". Try a tighter box or color+subcategory.`,
				422
			);
		}

		let catalogBytes: ArrayBuffer;
		try {
			catalogBytes = await fetchImageAsArrayBuffer(hit.imageUrl);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'fetch failed';
			throw new CatalogSearchError(`Failed to download catalog image: ${message}`, 502);
		}

		log.info('catalog_search_ok', {
			engine: hit.engine,
			source_title: hit.title.slice(0, 120),
			bytes: catalogBytes.byteLength,
		});

		return {
			pngBytes: new Uint8Array(catalogBytes),
			contentType: 'image/jpeg',
			imageKey,
			cropImageKey,
			queryUsed,
			provider: this.provider.name,
			engine: hit.engine,
			sourceTitle: hit.title,
			source: hit.source,
			hitImageUrl: hit.imageUrl,
		};
	}
}

export const createCatalogService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({ service: 'catalog' });
	return new CatalogService(
		createCatalogSearchProvider(envBindings),
		envBindings.OUTFIT_PHOTOS_BUCKET,
		envBindings.IMAGES,
		logger
	);
};
