import { fetchImageAsArrayBuffer, signDownloadUrlForKey } from '../../utils/assets.utils';
import { getImageDimensions } from '../../utils/image.utils';
import { Logger, createLogger } from '../../utils/logger.utils';
import { buildCatalogQuery } from './catalog_query';
import {
	CatalogHit,
	CatalogSearchError,
	CatalogSearchProvider,
	createCatalogSearchProvider,
} from './providers';

export type PercentBox = {
	x: number;
	y: number;
	width: number;
	height: number;
};

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

function percentBoxToTrim(
	box: PercentBox,
	imgW: number,
	imgH: number
): { top: number; left: number; bottom: number; right: number } {
	const padW = Math.max(1, Math.min(5, box.width * 0.1));
	const padH = Math.max(1, Math.min(5, box.height * 0.1));
	const paddedX = Math.max(0, box.x - padW);
	const paddedY = Math.max(0, box.y - padH);
	const paddedW = Math.min(100 - paddedX, box.width + padW * 2);
	const paddedH = Math.min(100 - paddedY, box.height + padH * 2);

	const top = Math.round((paddedY / 100) * imgH);
	const left = Math.round((paddedX / 100) * imgW);
	const bottom = Math.max(0, Math.round(imgH - ((paddedY + paddedH) / 100) * imgH));
	const right = Math.max(0, Math.round(imgW - ((paddedX + paddedW) / 100) * imgW));

	return { top, left, bottom, right };
}

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
		const trim = percentBoxToTrim(boundingBox, dims.width, dims.height);

		const cropJpeg = await this.cropJpeg(sourceBytes, trim);
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

	private async cropJpeg(
		bytes: ArrayBuffer,
		trim: { top: number; left: number; bottom: number; right: number }
	): Promise<ArrayBuffer> {
		const oriented = (
			await this.images.input(new Blob([bytes]).stream()).output({
				format: 'image/jpeg',
				quality: 90,
			})
		).response();
		if (!oriented.ok || !oriented.body) {
			throw new CatalogSearchError(`Failed to orient outfit image (${oriented.status})`, 502);
		}

		const cropped = (
			await this.images.input(oriented.body).transform({ trim }).output({
				format: 'image/jpeg',
				quality: 85,
			})
		).response();
		if (!cropped.ok) {
			throw new CatalogSearchError(`Failed to crop outfit image (${cropped.status})`, 502);
		}
		return cropped.arrayBuffer();
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
