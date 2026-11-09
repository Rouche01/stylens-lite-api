import { error, RequestHandler } from 'itty-router';
import { createClosetDB } from 'db';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { apiError, logRouteError } from 'utils/error';

/** Keep tile titles short; Claude drafts are usually well under this. */
const MAX_LABEL_LENGTH = 80;

type UpdateClosetItemBody = {
	label?: unknown;
};

const updateClosetItemHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const userId = request.user.dbId;
		const itemId = request.params.id?.trim();
		if (!itemId) {
			return error(400, 'Closet item ID is required');
		}

		const body = (await request.json()) as UpdateClosetItemBody;
		if (typeof body.label !== 'string') {
			return error(400, 'label (string) is required');
		}
		const label = body.label.trim().replace(/\s+/g, ' ');
		if (!label) {
			return error(400, 'label must not be empty');
		}
		if (label.length > MAX_LABEL_LENGTH) {
			return error(400, `label must be at most ${MAX_LABEL_LENGTH} characters`);
		}

		const closetDB = createClosetDB(env.GOSTYLENS_DB);
		const updated = await closetDB.updateClosetItemLabel(userId, itemId, label);
		if (!updated) {
			return apiError(404, 'Closet item not found', 'CLOSET_ITEM_NOT_FOUND');
		}

		request.log.info('closet_item_renamed', {
			closet_item_id: updated.id,
			label_len: updated.label.length,
		});

		return new Response(JSON.stringify(updated), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		logRouteError(request.log, 'update_closet_item_failed', err, { item_id: request.params.id });
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default updateClosetItemHandler;
