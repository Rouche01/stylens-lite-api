import { createPostHogSink } from '../services/posthog.svc';
import { createLogger } from '../utils/logger.utils';
import { handleAvatarGenerationQueue } from './avatar';
import { handleClosetIdentityQueue, type ClosetIdentityQueueMessage } from './closetIdentity';
import { handleClosetMatchDigestQueue } from './closetMatchDigest';
import type { ClosetMatchDigestJob } from '../services/identity/notify/digest';
import type { AvatarGenerationJob } from '../services/avatar';

/** Bare queue names (local / top-level). Remote env uses `stylens-${name}`. */
export const QUEUE_NAME = {
	AVATAR_GENERATION: 'avatar-generation',
	CLOSET_MATCH_DIGEST: 'closet-match-digest',
	CLOSET_IDENTITY: 'closet-identity',
} as const;

export type QueueName = (typeof QUEUE_NAME)[keyof typeof QUEUE_NAME];

/** Matches bare local names (`closet-identity`) and prefixed remote names (`stylens-closet-identity`). */
function isNamedQueue(queueName: string, base: QueueName): boolean {
	return queueName === base || queueName.endsWith(`-${base}`);
}

export function isClosetMatchDigestQueue(queueName: string): boolean {
	return isNamedQueue(queueName, QUEUE_NAME.CLOSET_MATCH_DIGEST);
}

export function isAvatarGenerationQueue(queueName: string): boolean {
	return isNamedQueue(queueName, QUEUE_NAME.AVATAR_GENERATION);
}

export function isClosetIdentityQueue(queueName: string): boolean {
	return isNamedQueue(queueName, QUEUE_NAME.CLOSET_IDENTITY);
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
