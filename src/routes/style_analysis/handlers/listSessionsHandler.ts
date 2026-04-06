import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { getPaginationMetadata } from '../utils';
import { ProvisionedAuthRequest } from 'types';

const listSessionsHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const url = new URL(request.url);
		const page = parseInt(url.searchParams.get('page') || '1', 10);
		const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);

		let isFavouriteParam = url.searchParams.get('is_favourite');
		let isFavourite: boolean | undefined = undefined;

		if (isFavouriteParam === 'true') {
			isFavourite = true;
		} else if (isFavouriteParam === 'false') {
			isFavourite = false;
		}

		if (page < 1 || pageSize < 1) {
			return error(400, 'page and pageSize must be positive integers');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);

		// Get all sessions for the user, potentially filtered by favourites
		const { sessions, total } = await styleAnalysisDB.getUserSessions(request.user.dbId, { page, pageSize, isFavourite });
		const paginationMetadata = getPaginationMetadata(total, page, pageSize);

		return new Response(JSON.stringify({ sessions, pagination: paginationMetadata }), {
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default listSessionsHandler;
