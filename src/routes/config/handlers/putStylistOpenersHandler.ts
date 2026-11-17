import { error, RequestHandler } from 'itty-router';
import { createStylistOpenersDB } from 'db';
import { AuthRequest } from 'types';
import { env } from 'cloudflare:workers';
import { validateStylistOpenersBody } from '../utils/validateStylistOpeners';

const putStylistOpenersHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		const body = await request.json();
		const validation = validateStylistOpenersBody(body);
		if (!validation.ok) {
			return error(400, validation.error);
		}

		const openersDB = createStylistOpenersDB(env.GOSTYLENS_DB);
		const pool = await openersDB.replacePool(validation.messages);

		return new Response(JSON.stringify(pool), {
			headers: {
				'Content-Type': 'application/json',
				ETag: `"${pool.version}"`,
				'Cache-Control': 'private, max-age=0, must-revalidate',
			},
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default putStylistOpenersHandler;
