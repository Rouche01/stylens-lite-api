import { createClosetDB } from '../db';
import {
	runClosetMatchDigest,
	type ClosetMatchDigestJob,
} from '../services/identity/notify/digest';
import { createPushService } from '../services/push.svc';
import type { Logger } from '../utils/logger.utils';

export async function handleClosetMatchDigestQueue(
	batch: MessageBatch<ClosetMatchDigestJob>,
	env: Env,
	log: Logger
): Promise<void> {
	const closet = createClosetDB(env.GOSTYLENS_DB);
	const push = createPushService(env, log);

	for (const message of batch.messages) {
		const userId = message.body?.userId?.trim();
		if (!userId) {
			log.warn('closet_match_digest_missing_user');
			message.ack();
			continue;
		}

		try {
			const decision = await runClosetMatchDigest({
				userId,
				closet,
				push,
				log,
			});
			if (decision.action === 'retry') {
				message.retry({ delaySeconds: decision.delaySeconds });
			} else {
				message.ack();
			}
		} catch (err) {
			log.error('closet_match_digest_failed', { user_id: userId, attempts: message.attempts }, err);
			if (message.attempts >= 3) {
				message.ack();
			} else {
				message.retry();
			}
		}
	}
}
