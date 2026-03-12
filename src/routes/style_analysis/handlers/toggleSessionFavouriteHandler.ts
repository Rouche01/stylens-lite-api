import { error, RequestHandler } from 'itty-router';
import { createFavouritesDB, createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';

export type ToggleFavouriteBody = {
    isFavourite: boolean;
};

const toggleSessionFavouriteHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
    try {
        const sessionId = request.params.sessionId;
        if (!sessionId) {
            return error(400, 'sessionId is required');
        }

        const body = await request.json<ToggleFavouriteBody>().catch(() => null);
        if (!body || typeof body.isFavourite !== 'boolean') {
            return error(400, 'isFavourite boolean is required in the body');
        }

        const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);
        const favouritesDB = createFavouritesDB(env.gostylens_db);

        // First ensure the session exists and belongs to the user
        const session = await styleAnalysisDB.getSession(sessionId, request.user.dbId);
        if (!session) {
            return error(404, 'Session not found');
        }

        if (body.isFavourite) {
            await favouritesDB.addHistoryFavourite(request.user.dbId, sessionId)
        } else {
            await favouritesDB.removeHistoryFavourite(request.user.dbId, sessionId)
        }

        return new Response(JSON.stringify({ success: true, isFavourite: body.isFavourite }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err) {
        if (err instanceof Error) {
            return error(400, err.message);
        }
        return error(500, 'Internal Server Error');
    }
};

export default toggleSessionFavouriteHandler;
