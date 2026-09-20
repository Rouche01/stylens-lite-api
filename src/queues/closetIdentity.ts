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
import {
	isClosetVectorBackfillJob,
	isClosetVectorRepairJob,
	runClosetVectorRepair,
	type ClosetVectorBackfillJob,
	type ClosetVectorRepairJob,
} from '../services/identity/closetVectorRepair';
import { createOutfitIdentityProcessor } from '../services/identity/processOutfitImage';
import { createIdentityService } from '../services/identity/identity.svc';
import { notifyClosetCatalogIfChanged } from '../services/identity/closetCatalogBroadcast';
import { createRealtimeService } from '../services/realtime.svc';
import type { Logger } from '../utils/logger.utils';

export type ClosetIdentityQueueMessage =
	| ClosetIdentityQueueJob
	| ClosetIdentitySettleJob
	| ClosetVectorRepairJob
	| ClosetVectorBackfillJob;

export async function handleClosetIdentityQueue(
	batch: MessageBatch<ClosetIdentityQueueMessage>,
	env: Env,
	log: Logger
): Promise<void> {
	const closet = createClosetDB(env.GOSTYLENS_DB);
	const processor = createOutfitIdentityProcessor(env, log);
	const identity = createIdentityService(env, log);
	const realtime = createRealtimeService();

	for (const message of batch.messages) {
		if (isClosetIdentitySettleJob(message.body)) {
			await handleSettleMessage(message as Message<ClosetIdentitySettleJob>, closet, realtime, log);
			continue;
		}

		if (isClosetVectorRepairJob(message.body) || isClosetVectorBackfillJob(message.body)) {
			await handleVectorRepairMessage(
				message as Message<ClosetVectorRepairJob | ClosetVectorBackfillJob>,
				closet,
				identity,
				env.CLOSET_IDENTITY_QUEUE,
				log
			);
			continue;
		}

		const decision = await runClosetIdentityJob({
			job: message.body,
			closet,
			process: (params) => processor.process(params),
			log,
			attempts: message.attempts,
			notifyCatalog: ({ userId, outfitId, items }) =>
				notifyClosetCatalogIfChanged({
					userId,
					outfitId,
					items,
					realtime,
					log,
				}),
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

async function handleVectorRepairMessage(
	message: Message<ClosetVectorRepairJob | ClosetVectorBackfillJob>,
	closet: ReturnType<typeof createClosetDB>,
	identity: ReturnType<typeof createIdentityService>,
	queue: Queue,
	log: Logger
): Promise<void> {
	try {
		const decision = await runClosetVectorRepair({
			job: message.body,
			closet,
			identity,
			log,
			attempts: message.attempts,
			queue,
		});
		if (decision.action === 'retry') {
			message.retry({ delaySeconds: decision.delaySeconds });
			return;
		}
		message.ack();
	} catch (err) {
		log.error(
			'closet_vector_repair_failed',
			{
				kind: message.body.kind,
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
