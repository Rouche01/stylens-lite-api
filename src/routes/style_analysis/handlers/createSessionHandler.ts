import { MessageEntry } from 'utils/types';
import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createStyleAnalysisDB, createSubscriptionsDB } from 'db';
import { generateTitle } from 'utils/style_analysis_session.utils';
import { isValidMessageEntry } from '../utils';
import { ProvisionedAuthRequest, SubscriptionTier } from 'types';

type CreateSessionBody = {
	title?: string;
	// Require initial message content
	messages: MessageEntry[];
};

const createSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const body = (await request.json()) as CreateSessionBody;

		if (!body.messages || body.messages.length === 0) {
			return error(400, 'At least one message is required to create a session');
		}

		// Validate messages
		const isValidMessages = body.messages.some((msg) => msg.role === 'user' && isValidMessageEntry(msg));

		if (!isValidMessages) {
			return error(400, 'At least one valid user message with content or image is required to create a session');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);
		const subscriptionsDB = createSubscriptionsDB(env.gostylens_db);

		const subscription = await subscriptionsDB.getSubscriptionByUserId(request.user.dbId);
		const currentUserTier = subscription?.tier || SubscriptionTier.Free;
		const hasReachedLimit = subscription?.has_reached_limit === 1;

		if (currentUserTier === SubscriptionTier.Free && hasReachedLimit) {
			return error(403, 'FREE_LIMIT_REACHED: Upgrade to GoStylens Core for unlimited sessions.');
		}

		// Create session with initial message
		const sessionResult = await styleAnalysisDB.createSessionWithInitialMessage({ ...body, userId: request.user.dbId });

		// If no explicit title was provided, generate one asynchronously and persist it.
		// Fire-and-forget; does not block the response to the client.
		const ctx = (request as any).ctx as ExecutionContext;

		if (!body.title) {
			const titleGenerationPromise = (async () => {
				try {
					const generated = await generateTitle(body.messages, { timeoutMs: 30000 });
					if (generated) {
						await styleAnalysisDB.updateSessionTitle(sessionResult.sessionId, generated);
						console.log(`Session ${sessionResult.sessionId} title updated to: ${generated}`);
					} else {
						console.log(`Session ${sessionResult.sessionId}: no title generated`);
					}
				} catch (err) {
					// Important log
					console.warn('Async title update failed for session', sessionResult.sessionId, err);
				}
			})();

			if (ctx?.waitUntil) {
				ctx.waitUntil(titleGenerationPromise);
			}
		}

		// Asynchronously check if the new session pushes them to/over the limit
		const limitCheckPromise = (async () => {
			try {
				if (currentUserTier === SubscriptionTier.Free) {
					const freeTierLimit = parseInt((env as unknown as Env).FREE_TIER_SESSION_LIMIT || '3', 10);
					const totalSessionsCount = await styleAnalysisDB.countTotalSessions(request.user.dbId);
					if (totalSessionsCount >= freeTierLimit) {
						const sub = await subscriptionsDB.getSubscriptionByUserId(request.user.dbId);
						if (sub && sub.id) {
							await subscriptionsDB.updateSubscription(sub.id, { has_reached_limit: 1 });

						}
					}
				}
			} catch (err) {
				// Important log
				console.warn('Async limit check failed for user', request.user.dbId, err);
			}
		})();

		if (ctx?.waitUntil) {
			ctx.waitUntil(limitCheckPromise);
		}

		return new Response(
			JSON.stringify({ sessionId: sessionResult.sessionId, title: sessionResult.title, messageIds: sessionResult.messageIds }),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default createSessionHandler;
