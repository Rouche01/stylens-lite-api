import { MessageEntry } from 'utils/types';
import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import { createStyleAnalysisDB } from 'db';
import { generateTitle } from 'utils/style_analysis_session.utils';
import { isValidMessageEntry } from '../utils';

type CreateSessionBody = {
	userId: string;
	title?: string;
	// Require initial message content
	messages: MessageEntry[];
};

const createSessionHandler: RequestHandler = async (request) => {
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

		// Create session with initial message
		const sessionResult = await styleAnalysisDB.createSessionWithInitialMessage(body);

		// If no explicit title was provided, generate one asynchronously and persist it.
		// Fire-and-forget; does not block the response to the client.
		if (!body.title) {
			const ctx = (request as any).ctx as ExecutionContext;

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
					console.warn('Async title update failed for session', sessionResult.sessionId, err);
				}
			})();

			if (ctx?.waitUntil) {
				ctx.waitUntil(titleGenerationPromise);
			}
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
