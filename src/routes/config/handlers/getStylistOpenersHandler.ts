import { error, RequestHandler } from 'itty-router';
import { createStylistOpenersDB } from 'db';
import { AuthRequest } from 'types';
import { env } from 'cloudflare:workers';

function etagForVersion(version: number): string {
	return `"${version}"`;
}

function ifNoneMatchMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const parts = header.split(',').map((part) => part.trim());
	return parts.includes('*') || parts.includes(etag);
}

const getStylistOpenersHandler: RequestHandler<AuthRequest> = async (request) => {
	try {
		const openersDB = createStylistOpenersDB(env.GOSTYLENS_DB);
		const version = await openersDB.getVersion();
		const etag = etagForVersion(version);

		if (ifNoneMatchMatches(request.headers.get('If-None-Match'), etag)) {
			return new Response(null, {
				status: 304,
				headers: {
					ETag: etag,
					'Cache-Control': 'private, max-age=0, must-revalidate',
				},
			});
		}

		const pool = await openersDB.getPool();
		return new Response(JSON.stringify(pool), {
			headers: {
				'Content-Type': 'application/json',
				ETag: etagForVersion(pool.version),
				'Cache-Control': 'private, max-age=0, must-revalidate',
			},
		});
	} catch (err) {
		request.log?.error('get_stylist_openers_failed', {}, err);
		return error(500, 'Internal Server Error');
	}
};

export default getStylistOpenersHandler;
