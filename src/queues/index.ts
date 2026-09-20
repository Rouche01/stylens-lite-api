import { createPostHogSink } from '../services/posthog.svc';
import { createLogger } from '../utils/logger.utils';
import { handleAvatarGenerationQueue } from './avatar';
import { handleClosetIdentityQueue, type ClosetIdentityQueueMessage } from './closetIdentity';
import { handleClosetMatchDigestQueue } from './closetMatchDigest';
import type { ClosetMatchDigestJob } from '../services/identity/notify/digest';
import type { AvatarGenerationJob } from '../services/avatar';

export function isClosetMatchDigestQueue(queueName: string): boolean {
	return queueName === 'closet-match-digest' || queueName === 'closet-match-digest-staging';
}

export function isAvatarGenerationQueue(queueName: string): boolean {
	return queueName === 'avatar-generation' || queueName === 'avatar-generation-staging';
}

export function isClosetIdentityQueue(queueName: string): boolean {
	return queueName === 'closet-identity' || queueName === 'closet-identity-staging';
}

export async function dispatchQueue(
	batch: MessageBatch,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	const sink = createPostHogSink(env);
	const log = createLogger({
		env: env.ENV_NAME,
		sink,
		context: {
			handler: 'queue',
			queue: batch.queue,
		},
	});

	try {
		if (isClosetMatchDigestQueue(batch.queue)) {
			await handleClosetMatchDigestQueue(batch as MessageBatch<ClosetMatchDigestJob>, env, log);
			return;
		}
		if (isClosetIdentityQueue(batch.queue)) {
			await handleClosetIdentityQueue(batch as MessageBatch<ClosetIdentityQueueMessage>, env, log);
			return;
		}
		if (isAvatarGenerationQueue(batch.queue)) {
			await handleAvatarGenerationQueue(batch as MessageBatch<AvatarGenerationJob>, env, log);
			return;
		}
		log.warn('unknown_queue', { queue: batch.queue });
	} finally {
		sink?.flush(ctx);
	}
}
