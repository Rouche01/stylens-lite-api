import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { OutfitLinkedItem } from 'db/closet';
import { env } from 'cloudflare:workers';
import {
	createCutoutService,
	evaluateFaceCutoutPng,
	falBirefnetMatte,
	falNanoBananaFlatlay,
	passesFaceQuality,
	SegmentError,
} from 'services/segmentation';
import { packshotTypeLabel } from 'services/closet_face/packshotLabel';
import { ApiRequest } from 'types';
import {
	CLOSET_PREVIEW_CROP_WIDTH,
	CLOSET_TILE_ISOLATE_WIDTH,
	getIsolatedItemUrl,
	signClosetOriginalUrl,
	signDownloadUrlForKey,
} from 'utils/assets.utils';
import { boxInCrop, closetTilePad, nativeAspectFocusWindow, padPercentBox } from 'utils/bounding_box';
import { getImageDimensions } from 'utils/image.utils';
import { logRouteError } from 'utils/error';
import {
	CLOSET_SCREEN_FALLBACK_ASPECT,
	PreviewBox,
	renderClosetFaceCompareHtml,
	renderClosetPreviewHtml,
	renderClosetScreenHtml,
} from './closetPreviewHtml';

const previewClosetItemHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const itemId = request.params.id;
		if (!itemId) {
			return error(400, 'Closet item ID is required');
		}

		const requestUrl = new URL(request.url);
		const showAll = requestUrl.searchParams.get('all') === '1';
		const outfitIdParam = requestUrl.searchParams.get('outfit_id')?.trim() || undefined;
		const layout = requestUrl.searchParams.get('layout');
		const closetLayout = layout === 'closet';
		const faceLayout = layout === 'face';
		const wantPackshot = requestUrl.searchParams.get('packshot') === '1';
		const enhance = requestUrl.searchParams.get('enhance') === 'true';

		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const details = await closetDB.getClosetItemDetailsById(itemId);
		if (!details) {
			return error(404, 'Closet item not found');
		}

		const wear = outfitIdParam
			? details.wear_history.find((event) => event.outfit_id === outfitIdParam)
			: details.wear_history[0];

		if (!wear) {
			return error(404, outfitIdParam ? 'outfit_id is not in this item wear history' : 'No outfit photo linked to this closet item');
		}

		const imageUrl = await signClosetOriginalUrl(wear.image_key, wear.original_image_url);
		if (!imageUrl) {
			return error(404, 'No outfit photo linked to this closet item');
		}

		if (faceLayout) {
			const catalog = await closetDB.getClosetItems(details.user_id);
			const listed = catalog.find((item) => item.id === itemId);
			const ratio =
				listed?.tile_aspect_ratio != null && listed.tile_aspect_ratio > 0
					? listed.tile_aspect_ratio
					: CLOSET_SCREEN_FALLBACK_ASPECT;
			const cropUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: wear.bounding_box,
				width: CLOSET_PREVIEW_CROP_WIDTH,
				cutout: false,
				category: details.category,
			});
			const cfCutoutUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: wear.bounding_box,
				width: CLOSET_TILE_ISOLATE_WIDTH,
				enhance,
				category: details.category,
			});

			const storedCutoutUrl = details.cutout_image_key?.trim()
				? await signDownloadUrlForKey(details.cutout_image_key.trim())
				: '';
			const storedFlatlayUrl = details.flatlay_image_key?.trim()
				? await signDownloadUrlForKey(details.flatlay_image_key.trim())
				: '';

			// Prefer persisted faces for judgment; only regenerate when missing / forced.
			let face = {
				url: storedCutoutUrl || '',
				note: storedCutoutUrl ? 'Stored cutout_image_key' : '',
				model: storedCutoutUrl ? 'stored' : '',
			};
			if (!storedCutoutUrl) {
				face = await buildSamFace({
					imageKey: wear.image_key,
					label: details.label,
					boundingBox: wear.bounding_box,
					category: details.category,
					log: request.log,
					signal: request.signal,
				});
			}

			let packshot: { url: string; note: string; model: string; r2Key?: string } = {
				url: storedFlatlayUrl || '',
				note: storedFlatlayUrl
					? 'Stored flatlay_image_key (list isolated_image_url)'
					: 'Append &packshot=1 or tap Run packshot (Nano Banana edit; slow / billed).',
				model: storedFlatlayUrl ? 'stored' : '',
			};
			if (!storedFlatlayUrl && wantPackshot) {
				packshot = await buildPackshotFace({
					sourceUrl: face.url || (await signDownloadUrlForKey(wear.image_key)),
					label: packshotTypeLabel({
						label: details.label,
						category: details.category,
						subcategory: details.subcategory,
					}),
					color: details.color,
					category: details.category,
					subcategory: details.subcategory,
					log: request.log,
					signal: request.signal,
				});
				const persistPackshot = requestUrl.searchParams.get('persist') === '1';
				if (persistPackshot && packshot.r2Key) {
					const flatlayKey = `cutouts/faces/${itemId}/flatlay-${crypto.randomUUID()}.png`;
					const obj = await env.OUTFIT_PHOTOS_BUCKET.get(packshot.r2Key);
					if (obj) {
						await env.OUTFIT_PHOTOS_BUCKET.put(flatlayKey, await obj.arrayBuffer(), {
							httpMetadata: { contentType: 'image/png' },
						});
						await closetDB.updateClosetItemFace({
							userId: details.user_id,
							closetItemId: itemId,
							flatlayImageKey: flatlayKey,
						});
						packshot = {
							...packshot,
							url: await signDownloadUrlForKey(flatlayKey),
							note: `${packshot.note}; persisted flatlay_image_key`,
						};
					}
				}
			}

			const html = renderClosetFaceCompareHtml({
				title: details.label,
				subtitle: `${details.color} ${details.subcategory}`.trim(),
				itemId,
				label: details.label,
				cropUrl,
				cfCutoutUrl,
				samFaceUrl: face.url,
				samNote: face.note,
				samModel: face.model,
				packshotUrl: packshot.url,
				packshotNote: packshot.note,
				packshotModel: packshot.model,
				aspectRatio: ratio,
			});
			return previewHtml(html);
		}

		if (closetLayout) {
			const catalog = await closetDB.getClosetItems(details.user_id);
			const listed = catalog.find((item) => item.id === itemId);
			const ratio =
				listed?.tile_aspect_ratio != null && listed.tile_aspect_ratio > 0
					? listed.tile_aspect_ratio
					: CLOSET_SCREEN_FALLBACK_ASPECT;
			const cropUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: wear.bounding_box,
				width: CLOSET_PREVIEW_CROP_WIDTH,
				cutout: false,
				category: details.category,
			});
			const isolateUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: wear.bounding_box,
				width: CLOSET_TILE_ISOLATE_WIDTH,
				enhance,
			});
			const paddedBox = padPercentBox(wear.bounding_box, closetTilePad(details.category));
			const photoSize = await outfitPhotoSize(wear.image_key, wear.image_width, wear.image_height);
			const focus = photoSize
				? nativeAspectFocusWindow(wear.bounding_box, photoSize.width, photoSize.height, details.category)
				: { x: 0, y: 0, width: 100, height: 100 };
			const itemCropUrl = getIsolatedItemUrl({
				domain: requestUrl.origin,
				imageUrl,
				imageKey: wear.image_key,
				boundingBox: focus,
				width: CLOSET_PREVIEW_CROP_WIDTH,
				cutout: false,
				pad: false,
			});
			const seedInCrop = boxInCrop(wear.bounding_box, focus) ?? wear.bounding_box;
			const html = renderClosetScreenHtml({
				title: details.label,
				subtitle: `${details.color} ${details.subcategory}`.trim(),
				itemId,
				label: details.label,
				cropUrl,
				isolateUrl,
				originalUrl: imageUrl,
				itemCropUrl,
				paddedBox,
				seedBox: seedInCrop,
				aspectRatio: ratio,
				aspectFallback: listed?.tile_aspect_ratio == null || listed.tile_aspect_ratio <= 0,
				blurHash: listed?.blur_hash || '',
				photoWidth: photoSize?.width ?? wear.image_width,
				photoHeight: photoSize?.height ?? wear.image_height,
			});
			return previewHtml(html);
		}

		let boxes: PreviewBox[];
		if (showAll) {
			const linked: OutfitLinkedItem[] = await closetDB.getOutfitLinkedItems(wear.outfit_id);
			boxes = linked.map((item) => ({
				closet_item_id: item.closet_item_id,
				label: item.label,
				color: item.color,
				bounding_box: item.bounding_box,
				highlighted: item.closet_item_id === itemId,
			}));
		} else {
			boxes = [
				{
					closet_item_id: details.id,
					label: details.label,
					color: details.color,
					bounding_box: wear.bounding_box,
					highlighted: true,
				},
			];
		}

		const html = renderClosetPreviewHtml({
			title: details.label,
			subtitle: showAll
				? `All items on outfit ${wear.outfit_id}`
				: `${details.color} ${details.subcategory}`.trim(),
			imageUrl,
			boxes,
			showAll,
		});

		return previewHtml(html);
	} catch (err) {
		logRouteError(request.log, 'preview_closet_item_failed', err, { item_id: request.params.id });
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

async function buildPackshotFace(params: {
	sourceUrl: string;
	label: string;
	color?: string | null;
	category?: string | null;
	subcategory?: string | null;
	log: ApiRequest['log'];
	signal?: AbortSignal;
}): Promise<{ url: string; note: string; model: string; r2Key?: string }> {
	if (!params.sourceUrl) {
		return { url: '', note: 'No source image for packshot', model: '' };
	}
	try {
		const result = await falNanoBananaFlatlay({
			apiKey: env.FAL_KEY,
			imageUrl: params.sourceUrl,
			label: params.label,
			color: params.color,
			category: params.category,
			subcategory: params.subcategory,
			log: params.log,
			signal: params.signal,
		});
		const key = `cutouts/scratch/face-packshot-${crypto.randomUUID()}.png`;
		await env.OUTFIT_PHOTOS_BUCKET.put(key, result.pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});
		return {
			url: await signDownloadUrlForKey(key),
			note: `Nano Banana flat-lay ok (${result.model})`,
			model: result.model,
			r2Key: key,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Packshot failed';
		params.log.warn('preview_face_packshot_failed', { error: msg });
		return { url: '', note: msg.slice(0, 200), model: '' };
	}
}

async function buildSamFace(params: {
	imageKey: string;
	label: string;
	boundingBox: { x: number; y: number; width: number; height: number };
	category?: string | null;
	log: ApiRequest['log'];
	signal?: AbortSignal;
}): Promise<{ url: string; note: string; model: string }> {
	try {
		const cutoutService = createCutoutService(env, params.log);
		const result = await cutoutService.cutoutFaceFromR2({
			imageKey: params.imageKey,
			label: params.label,
			boundingBox: params.boundingBox,
			category: params.category,
			signal: params.signal,
		});

		const qualityNote = `opaque=${result.quality.opaqueFrac.toFixed(3)} bbox=${result.quality.opaqueBboxFrac.toFixed(3)} luma=${result.quality.meanLuma.toFixed(0)}±${result.quality.lumaStd.toFixed(0)} fill=${result.quality.fillDensity.toFixed(2)}${
			result.maskScore != null ? ` score=${result.maskScore.toFixed(3)}` : ''
		}`;

		if (!result.verdict.ok) {
			params.log?.warn('preview_face_quality_reject', {
				reason: result.verdict.reason,
				opaque_frac: result.quality.opaqueFrac,
				opaque_bbox_frac: result.quality.opaqueBboxFrac,
				mask_score: result.maskScore ?? null,
				model: result.model,
			});
			return {
				url: '',
				note: `Face quality reject (${result.verdict.reason}; ${qualityNote}). Keep padded crop.`,
				model: result.model,
			};
		}

		const samKey = `cutouts/scratch/face-sam-${crypto.randomUUID()}.png`;
		await env.OUTFIT_PHOTOS_BUCKET.put(samKey, result.pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});
		const samUrl = await signDownloadUrlForKey(samKey);

		let note = `SAM ok (${result.model}${result.promptUsed ? `; prompt ${result.promptUsed}` : ''}; ${qualityNote})`;
		let model = result.model;

		try {
			const faceBytes = await falBirefnetMatte({
				apiKey: env.FAL_KEY,
				imageUrl: samUrl,
				log: params.log,
				signal: params.signal,
			});
			const matteQuality = await evaluateFaceCutoutPng(faceBytes, result.maskScore ?? null);
			const matteVerdict = passesFaceQuality(matteQuality, { category: params.category });
			if (!matteVerdict.ok) {
				params.log?.warn('preview_face_matte_quality_reject', {
					reason: matteVerdict.reason,
					opaque_frac: matteQuality.opaqueFrac,
					mean_luma: matteQuality.meanLuma,
				});
				// Don't promote raw SAM when matting collapses to a black void / hollow — keep padded crop.
				return {
					url: '',
					note: `Face quality reject after BiRefNet (${matteVerdict.reason}; ${qualityNote}). Keep padded crop.`,
					model: `${result.model}+birefnet`,
				};
			}
			const matteKey = `cutouts/scratch/face-matte-${crypto.randomUUID()}.png`;
			await env.OUTFIT_PHOTOS_BUCKET.put(matteKey, faceBytes, {
				httpMetadata: { contentType: 'image/png' },
			});
			model = `${result.model}+birefnet`;
			note = `SAM + BiRefNet ok (${result.model}; ${qualityNote})`;
			return { url: await signDownloadUrlForKey(matteKey), note, model };
		} catch (matteErr) {
			const matteMsg = matteErr instanceof Error ? matteErr.message : 'BiRefNet failed';
			params.log?.warn('preview_face_birefnet_failed', { error: matteMsg });
			note = `SAM ok; BiRefNet skipped (${matteMsg.slice(0, 120)}). ${qualityNote}`;
			return { url: samUrl, note, model };
		}
	} catch (err) {
		const msg =
			err instanceof SegmentError
				? err.message
				: err instanceof Error
					? err.message
					: 'SAM cutout failed';
		params.log?.warn('preview_face_sam_failed', { error: msg });
		return { url: '', note: msg.slice(0, 200), model: '' };
	}
}

async function outfitPhotoSize(
	imageKey: string | undefined,
	storedW: number | null,
	storedH: number | null
): Promise<{ width: number; height: number } | null> {
	if (storedW != null && storedW > 0 && storedH != null && storedH > 0) {
		return { width: storedW, height: storedH };
	}
	if (!imageKey) return null;
	try {
		const obj = await env.OUTFIT_PHOTOS_BUCKET.get(imageKey);
		if (!obj) return null;
		const dims = await getImageDimensions(await obj.arrayBuffer());
		if (!(dims.width > 0) || !(dims.height > 0)) return null;
		return dims;
	} catch {
		return null;
	}
}

function previewHtml(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

export default previewClosetItemHandler;
