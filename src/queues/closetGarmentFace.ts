import {
	createGarmentFaceService,
	type GarmentFaceJob,
} from '../services/closet_face/garmentFace.svc';
import type { Logger } from '../utils/logger.utils';

export async function handleClosetGarmentFaceQueue(
	batch: MessageBatch<GarmentFaceJob>,
	env: Env,
	log: Logger
): Promise<void> {
	const service = createGarmentFaceService(env, log);

	for (const message of batch.messages) {
		const body = message.body;
		try {
			if (!body?.closetItemId || !body?.userId || !body?.imageKey || !body?.boundingBox) {
				log.warn('garment_face_job_invalid', { body: JSON.stringify(body).slice(0, 200) });
				message.ack();
				continue;
			}
			if (body.type !== 'cutout' && body.type !== 'packshot') {
				log.warn('garment_face_job_unknown_type', { type: String(body.type) });
				message.ack();
				continue;
			}
			await service.process(body);
			message.ack();
		} catch (err) {
			log.error(
				'garment_face_job_failed',
				{
					type: body?.type,
					closet_item_id: body?.closetItemId,
					user_id: body?.userId,
					attempts: message.attempts,
				},
				err
			);
			if (message.attempts >= 3) {
				message.ack();
			} else {
				message.retry();
			}
		}
	}
}
