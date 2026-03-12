import { error, RequestHandler } from 'itty-router';
import { createFavouritesDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';

const listFavouritesHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
    try {
        const favouritesDB = createFavouritesDB(env.gostylens_db);

        const favourites = await favouritesDB.getHistoryFavourites(request.user.dbId);

        return new Response(JSON.stringify({ favourites }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (err) {
        if (err instanceof Error) {
            return error(400, err.message);
        }
        return error(500, 'Internal Server Error');
    }
};

export default listFavouritesHandler;
