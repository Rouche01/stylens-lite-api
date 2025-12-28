import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from '../../../db';
import { env } from 'cloudflare:workers';

const getSessionMessagesHandler: RequestHandler = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };

		// Extract userId from query parameters
		const url = new URL(request.url);
		const userId = url.searchParams.get('userId');

		if (!userId) {
			return error(400, 'userId query parameter is required');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);

		// First, verify session exists and belongs to user
		const session = await styleAnalysisDB.getSession(sessionId, userId);
		if (!session) {
			return error(404, 'Session not found or access denied');
		}

		// Now get messages for the session
		const messages = await styleAnalysisDB.getSessionMessages(sessionId);

		return new Response(
			JSON.stringify({
				sessionId,
				sessionTitle: session.title,
				userId: session.user_id,
				messages,
				total: messages.length,
				createdAt: session.created_at,
				updatedAt: session.updated_at,
			}),
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

export default getSessionMessagesHandler;
