import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';

const deleteSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);

		// First, verify session exists and belongs to user
		const session = await styleAnalysisDB.getSession(sessionId, request.user.dbId);
		if (!session) {
			return error(404, 'Session not found or access denied');
		}

		// Now delete the session
		await styleAnalysisDB.softDeleteSession(sessionId, request.user.dbId);

		return new Response(
			JSON.stringify({
				message: 'Session deleted successfully',
				sessionId,
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

export default deleteSessionHandler;
