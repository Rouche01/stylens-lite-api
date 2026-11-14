import { createClosetDB } from '../../db';
import {
	createCutoutService,
	evaluateFaceCutoutPng,
	falBirefnetMatte,
	falNanoBananaFlatlay,
	packshotRequiresTrustedCutout,
	passesFaceQuality,
} from '../segmentation';
import { faceSourceFromKeys } from '../../utils/closet_face';
import { Logger } from '../../utils/logger.utils';
import { signDownloadUrlForKey } from '../../utils/assets.utils';

export type GarmentFaceJobType = 'cutout' | 'packshot';

export type GarmentFaceJob = {
	type: GarmentFaceJobType;
	userId: string;
	closetItemId: string;
	imageKey: string;
	label: string;
	/** Extract color — packshot prompt hint; reference pixels win on conflict. */
	color?: string | null;
	category?: string | null;
	subcategory?: string | null;
	boundingBox: { x: number; y: number; width: number; height: number };
	/** Required for packshot when cutting from the wear photo. */
	sourceImageKey?: string;
	/**
	 * When true, after cutout settles (store or quality reject), enqueue packshot.
	 * Used so cutout and packshot never race on the same tile.
	 */
	followWithPackshot?: boolean;
};

export type GarmentFaceEnqueuePlan = 'cutout_then_packshot' | 'packshot' | 'cutout' | 'none';

/** Pure enqueue planner — cutout completes before packshot when both flags are on. */
export function garmentFaceEnqueuePlan(flags: {
	cutoutEnabled: boolean;
	packshotEnabled: boolean;
}): GarmentFaceEnqueuePlan {
	if (flags.cutoutEnabled && flags.packshotEnabled) return 'cutout_then_packshot';
	if (flags.packshotEnabled) return 'packshot';
	if (flags.cutoutEnabled) return 'cutout';
	return 'none';
}

function envFlagTrue(value: unknown): boolean {
	return String(value || '').toLowerCase() === 'true';
}

export class GarmentFaceService {
	constructor(
		private env: Env,
		private log: Logger
	) {}

	async process(job: GarmentFaceJob): Promise<void> {
		if (job.type === 'packshot') {
			await this.processPackshot(job);
			return;
		}
		await this.processCutout(job);
	}

	private closet() {
		return createClosetDB(this.env.GOSTYLENS_DB);
	}

	private async processCutout(job: GarmentFaceJob): Promise<void> {
		const log = this.log.child({
			service: 'garment_face',
			job_type: 'cutout',
			closet_item_id: job.closetItemId,
			user_id: job.userId,
		});
		const cutout = createCutoutService(this.env, log);
		const result = await cutout.cutoutFaceFromR2({
			imageKey: job.imageKey,
			boundingBox: job.boundingBox,
			label: job.label,
			category: job.category,
		});

		if (!result.verdict.ok) {
			log.info('garment_face_cutout_rejected', {
				reason: result.verdict.reason,
				opaque_frac: result.quality.opaqueFrac,
				mean_luma: result.quality.meanLuma,
			});
			await this.enqueueFollowPackshot(job, log, { cutoutTrusted: false });
			return;
		}

		if (!result.pngBytes.length) {
			log.info('garment_face_cutout_rejected', { reason: 'empty_png' });
			await this.enqueueFollowPackshot(job, log, { cutoutTrusted: false });
			return;
		}

		let pngBytes = result.pngBytes;
		try {
			const samKey = `cutouts/faces/${job.closetItemId}/sam-${crypto.randomUUID()}.png`;
			await this.env.OUTFIT_PHOTOS_BUCKET.put(samKey, result.pngBytes, {
				httpMetadata: { contentType: 'image/png' },
			});
			const matte = await falBirefnetMatte({
				apiKey: this.env.FAL_KEY,
				imageUrl: await signDownloadUrlForKey(samKey),
			});
			const matteQuality = await evaluateFaceCutoutPng(matte, result.maskScore ?? null);
			const matteVerdict = passesFaceQuality(matteQuality, { category: job.category });
			if (matteVerdict.ok) {
				pngBytes = matte;
			} else {
				// Quality reject is terminal (ack) — same crop will not magically pass.
				log.info('garment_face_matte_rejected', { reason: matteVerdict.reason });
				await this.enqueueFollowPackshot(job, log, { cutoutTrusted: false });
				return;
			}
		} catch (err) {
			// Transient Fal/network errors should retry via the queue.
			log.warn('garment_face_matte_failed', {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		const cutoutKey = `cutouts/faces/${job.closetItemId}/cutout-${crypto.randomUUID()}.png`;
		await this.env.OUTFIT_PHOTOS_BUCKET.put(cutoutKey, pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});

		const updated = await this.closet().updateClosetItemFace({
			userId: job.userId,
			closetItemId: job.closetItemId,
			cutoutImageKey: cutoutKey,
		});
		if (!updated) {
			log.warn('garment_face_cutout_persist_missed', { cutout_image_key: cutoutKey });
			await this.enqueueFollowPackshot(job, log, { cutoutTrusted: false });
			return;
		}
		log.info('garment_face_cutout_stored', { cutout_image_key: cutoutKey });
		await this.enqueueFollowPackshot(job, log, { cutoutTrusted: true });
	}

	private async enqueueFollowPackshot(
		job: GarmentFaceJob,
		log: Logger,
		opts: { cutoutTrusted: boolean }
	): Promise<void> {
		if (!job.followWithPackshot) return;
		if (packshotRequiresTrustedCutout(job.category) && !opts.cutoutTrusted) {
			log.info('garment_face_packshot_skipped_untrusted_cutout', {
				closet_item_id: job.closetItemId,
				category: job.category || '',
			});
			return;
		}
		const { followWithPackshot: _follow, type: _type, ...rest } = job;
		// Cutout already settled (store or reject) — do not defer packshot back into cutout.
		await maybeEnqueueGarmentFacePackshot(this.env, rest, log, { afterCutoutSettled: true });
	}

	private async processPackshot(job: GarmentFaceJob): Promise<void> {
		const log = this.log.child({
			service: 'garment_face',
			job_type: 'packshot',
			closet_item_id: job.closetItemId,
			user_id: job.userId,
		});
		const existing = await this.closet().getClosetItemFace(job.userId, job.closetItemId);
		if (existing?.flatlay_image_key?.trim()) {
			log.info('garment_face_packshot_skip_existing', {
				flatlay_image_key: existing.flatlay_image_key,
			});
			return;
		}

		const cutoutKey = existing?.cutout_image_key?.trim() || '';
		if (packshotRequiresTrustedCutout(job.category) && !cutoutKey) {
			// Footwear: no high-confidence cutout → do not store an untrusted flatlay for browse.
			log.info('garment_face_packshot_skipped_needs_cutout', {
				category: job.category || '',
			});
			return;
		}

		let sourceKey: string;
		let sourceKind: 'cutout' | 'padded_crop';
		if (cutoutKey) {
			sourceKey = cutoutKey;
			sourceKind = 'cutout';
		} else {
			// Apparel: never feed the full outfit photo — padded crop only.
			const cutout = createCutoutService(this.env, log);
			const cropped = await cutout.cropFaceJpegFromR2({
				imageKey: job.sourceImageKey || job.imageKey,
				boundingBox: job.boundingBox,
				label: job.label,
				category: job.category,
			});
			sourceKey = cropped.cropImageKey;
			sourceKind = 'padded_crop';
			log.info('garment_face_packshot_using_padded_crop', {
				crop_image_key: sourceKey,
				crop_width: cropped.cropWidth,
				crop_height: cropped.cropHeight,
			});
		}

		const sourceUrl = await signDownloadUrlForKey(sourceKey);
		const packshot = await falNanoBananaFlatlay({
			apiKey: this.env.FAL_KEY,
			imageUrl: sourceUrl,
			label: job.label,
			color: job.color,
			category: job.category,
			subcategory: job.subcategory,
		});
		const flatlayKey = `cutouts/faces/${job.closetItemId}/flatlay-${crypto.randomUUID()}.png`;
		await this.env.OUTFIT_PHOTOS_BUCKET.put(flatlayKey, packshot.pngBytes, {
			httpMetadata: { contentType: 'image/png' },
		});
		const updated = await this.closet().updateClosetItemFace({
			userId: job.userId,
			closetItemId: job.closetItemId,
			flatlayImageKey: flatlayKey,
		});
		if (!updated) {
			log.warn('garment_face_packshot_persist_missed', { flatlay_image_key: flatlayKey });
			return;
		}
		log.info('garment_face_packshot_stored', {
			flatlay_image_key: flatlayKey,
			packshot_source: sourceKind,
			face_source: faceSourceFromKeys({
				cutoutImageKey: cutoutKey || existing?.cutout_image_key,
				flatlayImageKey: flatlayKey,
			}),
		});
	}
}

export function createGarmentFaceService(env: Env, log: Logger) {
	return new GarmentFaceService(env, log);
}

/** Enqueue gated SAM cutout when env flag is on (off by default — Fal cost). */
export async function maybeEnqueueGarmentFaceCutout(
	env: Env,
	job: Omit<GarmentFaceJob, 'type'>,
	log?: Logger
): Promise<boolean> {
	if (!envFlagTrue(env.GARMENT_FACE_CUTOUT_ENABLED)) {
		return false;
	}
	const queue = env.CLOSET_GARMENT_FACE_QUEUE;
	if (!queue) {
		log?.warn('garment_face_queue_missing');
		return false;
	}
	await queue.send({ ...job, type: 'cutout' } satisfies GarmentFaceJob);
	log?.info('garment_face_cutout_enqueued', {
		closet_item_id: job.closetItemId,
		follow_with_packshot: Boolean(job.followWithPackshot),
	});
	return true;
}

/** Packshot for display faces — caller gates (create / ask→new / ask→same; never pending). */
export async function enqueueGarmentFacePackshot(
	env: Env,
	job: Omit<GarmentFaceJob, 'type'>,
	log?: Logger
): Promise<void> {
	const queue = env.CLOSET_GARMENT_FACE_QUEUE;
	if (!queue) {
		throw new Error('CLOSET_GARMENT_FACE_QUEUE is not bound');
	}
	await queue.send({ ...job, type: 'packshot' } satisfies GarmentFaceJob);
	log?.info('garment_face_packshot_enqueued', { closet_item_id: job.closetItemId });
}

/**
 * Enqueue generative packshot when env flag is on (off by default — Fal $).
 * Soft-fails when the queue binding is missing.
 *
 * When cutout is also enabled and this tile has no cutout yet, enqueues cutout with
 * `followWithPackshot` instead so packshot never races ahead of (or without) cutout.
 */
export async function maybeEnqueueGarmentFacePackshot(
	env: Env,
	job: Omit<GarmentFaceJob, 'type'>,
	log?: Logger,
	options?: { afterCutoutSettled?: boolean }
): Promise<boolean> {
	if (!envFlagTrue(env.GARMENT_FACE_PACKSHOT_ENABLED)) {
		return false;
	}
	const queue = env.CLOSET_GARMENT_FACE_QUEUE;
	if (!queue) {
		log?.warn('garment_face_queue_missing');
		return false;
	}

	// Ask→same/new may call packshot directly: if cutout is enabled and not done yet, run cutout first.
	if (
		!options?.afterCutoutSettled &&
		envFlagTrue(env.GARMENT_FACE_CUTOUT_ENABLED) &&
		!job.followWithPackshot
	) {
		const face = await createClosetDB(env.GOSTYLENS_DB).getClosetItemFace(job.userId, job.closetItemId);
		if (!face?.cutout_image_key?.trim()) {
			const cutoutOk = await maybeEnqueueGarmentFaceCutout(
				env,
				{ ...job, followWithPackshot: true },
				log
			);
			if (cutoutOk) {
				log?.info('garment_face_packshot_deferred_to_cutout', {
					closet_item_id: job.closetItemId,
				});
				return true;
			}
			// Cutout enqueue failed (flag/queue) — fall through to packshot on padded crop.
		}
	}

	const { followWithPackshot: _follow, ...packJob } = job;
	await queue.send({ ...packJob, type: 'packshot' } satisfies GarmentFaceJob);
	log?.info('garment_face_packshot_enqueued', { closet_item_id: job.closetItemId });
	return true;
}

type CreatedFaceItem = {
	identity_status?: string;
	is_new_closet_item?: boolean;
	closet_item_id?: string | null;
	label?: string;
	color?: string | null;
	category?: string | null;
	subcategory?: string | null;
	bounding_box?: GarmentFaceJob['boundingBox'] | null;
};

/**
 * After identity create (queue or admin HTTP extract): enqueue cutout + packshot
 * for each new tile. Flag-gated; safe no-op when disabled / unbound.
 * When both flags are on, only cutout is enqueued — packshot follows after cutout settles.
 */
export async function enqueueGarmentFacesForCreatedItems(
	env: Env,
	params: {
		userId: string;
		imageKey: string;
		items: CreatedFaceItem[];
	},
	log?: Logger
): Promise<void> {
	const plan = garmentFaceEnqueuePlan({
		cutoutEnabled: envFlagTrue(env.GARMENT_FACE_CUTOUT_ENABLED),
		packshotEnabled: envFlagTrue(env.GARMENT_FACE_PACKSHOT_ENABLED),
	});
	if (plan === 'none') return;

	for (const item of params.items) {
		if (
			item.identity_status !== 'created' ||
			!item.is_new_closet_item ||
			!item.closet_item_id ||
			!item.bounding_box ||
			!item.label
		) {
			continue;
		}
		const faceJob: Omit<GarmentFaceJob, 'type'> = {
			userId: params.userId,
			closetItemId: item.closet_item_id,
			imageKey: params.imageKey,
			sourceImageKey: params.imageKey,
			label: item.label,
			color: item.color,
			category: item.category,
			subcategory: item.subcategory,
			boundingBox: item.bounding_box,
		};

		if (plan === 'cutout_then_packshot') {
			await maybeEnqueueGarmentFaceCutout(env, { ...faceJob, followWithPackshot: true }, log);
			continue;
		}
		if (plan === 'cutout') {
			await maybeEnqueueGarmentFaceCutout(env, faceJob, log);
			continue;
		}
		await maybeEnqueueGarmentFacePackshot(env, faceJob, log);
	}
}
