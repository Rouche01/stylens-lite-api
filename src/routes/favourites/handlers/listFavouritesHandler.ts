import { error, RequestHandler } from 'itty-router';
import { createFavouritesDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { rewriteSessionCoversToProxy } from '../../../utils/asset_proxy_urls';

const listFavouritesHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const favouritesDB = createFavouritesDB(env.GOSTYLENS_DB);

		const favourites = await favouritesDB.getHistoryFavourites(request.user.dbId);
		const origin = new URL(request.url).origin;
		const favouritesWithProxyUrls = rewriteSessionCoversToProxy(favourites, origin);

		return new Response(JSON.stringify({ favourites: favouritesWithProxyUrls }), {
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
