import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from '../../../db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';

const deleteClosetItemHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const userId = request.user.dbId;
		const itemId = request.params.id;

		if (!itemId) {
			return error(400, 'Closet item ID is required');
		}

		const success = await closetDB.deleteClosetItem(userId, itemId);
		if (!success) {
			return error(400, 'Failed to delete closet item');
		}

		return new Response(JSON.stringify({ success: true, message: 'Closet item deleted successfully' }), {
			headers: { 'Content-Type': 'application/json' },
			status: 200
		});

	} catch (err) {
		console.error('Failed to delete closet item:', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default deleteClosetItemHandler;
