import { createClosetDB } from '../db';
import {
	runClosetIdentityJob,
	type ClosetIdentityQueueJob,
} from '../services/identity/closetIdentityJob';
import {
	isClosetIdentitySettleJob,
	runClosetIdentityProgress,
	type ClosetIdentitySettleJob,
} from '../services/identity/closetIdentityProgress';
import { createOutfitIdentityProcessor } from '../services/identity/processOutfitImage';
import { createRealtimeService } from '../services/realtime.svc';
import type { Logger } from '../utils/logger.utils';

export type ClosetIdentityQueueMessage = ClosetIdentityQueueJob | ClosetIdentitySettleJob;

export async function handleClosetIdentityQueue(
	batch: MessageBatch<ClosetIdentityQueueMessage>,
	env: Env,
	log: Logger
): Promise<void> {
	const closet = createClosetDB(env.GOSTYLENS_DB);
	const processor = createOutfitIdentityProcessor(env, log);
	const realtime = createRealtimeService();

	for (const message of batch.messages) {
		if (isClosetIdentitySettleJob(message.body)) {
			await handleSettleMessage(message as Message<ClosetIdentitySettleJob>, closet, realtime, log);
			continue;
		}

		const decision = await runClosetIdentityJob({
			job: message.body,
			closet,
			process: (params) => processor.process(params),
			log,
			attempts: message.attempts,
		});

		if (decision.action === 'retry') {
			message.retry({ delaySeconds: decision.delaySeconds });
		} else {
			message.ack();
		}

		const userId = message.body?.userId?.trim();
		if (!userId) continue;
		try {
			await runClosetIdentityProgress({
				userId,
				closet,
				realtime,
				log,
				queue: env.CLOSET_IDENTITY_QUEUE,
				scheduleOnRetry: true,
			});
		} catch (err) {
			log.warn('closet_identity_progress_sync_failed', { user_id: userId }, err);
		}
	}
}

async function handleSettleMessage(
	message: Message<ClosetIdentitySettleJob>,
	closet: ReturnType<typeof createClosetDB>,
	realtime: ReturnType<typeof createRealtimeService>,
	log: Logger
): Promise<void> {
	const userId = message.body?.userId?.trim();
	if (!userId) {
		log.warn('closet_identity_settle_missing_user');
		message.ack();
		return;
	}

	try {
		const decision = await runClosetIdentityProgress({
			userId,
			closet,
			realtime,
			log,
			scheduleOnRetry: false,
		});
		if (decision.action === 'retry') {
			message.retry({ delaySeconds: decision.delaySeconds });
			return;
		}
		message.ack();
	} catch (err) {
		log.error('closet_identity_settle_failed', { user_id: userId, attempts: message.attempts }, err);
		if (message.attempts >= 3) {
			message.ack();
		} else {
			message.retry();
		}
	}
}
