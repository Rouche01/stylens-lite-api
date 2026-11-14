import { createClosetDB } from '../../db';
import {
	createCutoutService,
	evaluateFaceCutoutPng,
	falBirefnetMatte,
	falNanoBananaFlatlay,
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
};

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
			const matteVerdict = passesFaceQuality(matteQuality);
			if (matteVerdict.ok) {
				pngBytes = matte;
			} else {
				// Quality reject is terminal (ack) — same crop will not magically pass.
				log.info('garment_face_matte_rejected', { reason: matteVerdict.reason });
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
			return;
		}
		log.info('garment_face_cutout_stored', { cutout_image_key: cutoutKey });
	}

	private async processPackshot(job: GarmentFaceJob): Promise<void> {
		const log = this.log.child({
			service: 'garment_face',
			job_type: 'packshot',
			closet_item_id: job.closetItemId,
			user_id: job.userId,
		});
		const existing = await this.closet().getClosetItemFace(job.userId, job.closetItemId);
		const sourceKey = existing?.cutout_image_key || job.sourceImageKey || job.imageKey;
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
			face_source: faceSourceFromKeys({
				cutoutImageKey: existing?.cutout_image_key,
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
	if (String(env.GARMENT_FACE_CUTOUT_ENABLED || '').toLowerCase() !== 'true') {
		return false;
	}
	const queue = env.CLOSET_GARMENT_FACE_QUEUE;
	if (!queue) {
		log?.warn('garment_face_queue_missing');
		return false;
	}
	await queue.send({ ...job, type: 'cutout' } satisfies GarmentFaceJob);
	log?.info('garment_face_cutout_enqueued', { closet_item_id: job.closetItemId });
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
 */
export async function maybeEnqueueGarmentFacePackshot(
	env: Env,
	job: Omit<GarmentFaceJob, 'type'>,
	log?: Logger
): Promise<boolean> {
	if (String(env.GARMENT_FACE_PACKSHOT_ENABLED || '').toLowerCase() !== 'true') {
		return false;
	}
	const queue = env.CLOSET_GARMENT_FACE_QUEUE;
	if (!queue) {
		log?.warn('garment_face_queue_missing');
		return false;
	}
	await queue.send({ ...job, type: 'packshot' } satisfies GarmentFaceJob);
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
		await maybeEnqueueGarmentFaceCutout(env, faceJob, log);
		await maybeEnqueueGarmentFacePackshot(env, faceJob, log);
	}
}
