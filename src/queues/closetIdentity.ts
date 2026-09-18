import { createClosetDB } from '../db';
import {
	runClosetIdentityJob,
	type ClosetIdentityQueueJob,
} from '../services/identity/closetIdentityJob';
import { createOutfitIdentityProcessor } from '../services/identity/processOutfitImage';
import type { Logger } from '../utils/logger.utils';

export async function handleClosetIdentityQueue(
	batch: MessageBatch<ClosetIdentityQueueJob>,
	env: Env,
	log: Logger
): Promise<void> {
	const closet = createClosetDB(env.GOSTYLENS_DB);
	const processor = createOutfitIdentityProcessor(env, log);

	for (const message of batch.messages) {
		const decision = await runClosetIdentityJob({
			job: message.body,
			closet,
			process: (params) => processor.process(params),
			log,
			attempts: message.attempts,
		});

		if (decision.action === 'retry') {
			message.retry({ delaySeconds: decision.delaySeconds });
			continue;
		}

		message.ack();
	}
}
