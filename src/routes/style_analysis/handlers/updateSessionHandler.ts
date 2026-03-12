import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';

type UpdateSessionBody = {
    title?: string;
};

const updateSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
    try {
        const { sessionId } = request.params;
        if (!sessionId) {
            return error(400, 'sessionId is required');
        }

        const body = await request.json<UpdateSessionBody>().catch(() => null);
        if (!body || Object.keys(body).length === 0) {
            return error(400, 'At least one field to update is required');
        }

        const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);

        // Ensure the session exists and belongs to the user
        const session = await styleAnalysisDB.getSession(sessionId, request.user.dbId);
        if (!session) {
            return error(404, 'Session not found');
        }

        // Apply updates
        if (body.title !== undefined) {
            if (typeof body.title !== 'string' || body.title.trim().length === 0) {
                return error(400, 'title must be a non-empty string');
            }
            await styleAnalysisDB.updateSessionTitle(sessionId, body.title.trim());
        }

        // Fetch the updated session to return
        const updatedSession = await styleAnalysisDB.getSession(sessionId, request.user.dbId);

        return new Response(JSON.stringify({ success: true, session: updatedSession }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err) {
        if (err instanceof Error) {
            return error(400, err.message);
        }
        return error(500, 'Internal Server Error');
    }
};

export default updateSessionHandler;
