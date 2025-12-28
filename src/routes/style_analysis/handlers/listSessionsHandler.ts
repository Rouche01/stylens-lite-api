import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from '../../../db';
import { env } from 'cloudflare:workers';

const listSessionsHandler: RequestHandler = async (request) => {
	try {
		// Extract userId from query parameters
		const url = new URL(request.url);
		const userId = url.searchParams.get('userId');

		if (!userId) {
			return error(400, 'userId query parameter is required');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);

		// Get all sessions for the user
		const sessions = await styleAnalysisDB.getUserSessions(userId);

		return new Response(
			JSON.stringify({
				sessions,
				total: sessions.length,
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

export default listSessionsHandler;
