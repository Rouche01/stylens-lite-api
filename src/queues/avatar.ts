import { createAvatarService, type AvatarGenerationJob } from '../services/avatar';
import type { Logger } from '../utils/logger.utils';

export async function handleAvatarGenerationQueue(
	batch: MessageBatch<AvatarGenerationJob>,
	env: Env,
	log: Logger
): Promise<void> {
	const avatarService = createAvatarService(env, log);

	for (const message of batch.messages) {
		const body = message.body;
		try {
			await avatarService.generate(body);
			message.ack();
		} catch (err) {
			log.error(
				'avatar_generate_failed',
				{
					avatar_id: body.avatarId,
					user_id: body.userId,
					attempts: message.attempts,
				},
				err
			);
			if (!avatarService.isRetryableGenerateError(err) || message.attempts >= 3) {
				await avatarService.failGeneration(body.avatarId, err);
				message.ack();
			} else {
				message.retry();
			}
		}
	}
}
