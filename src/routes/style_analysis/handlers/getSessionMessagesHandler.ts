import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { getPaginationMetadata } from '../utils';
import { ProvisionedAuthRequest } from 'types';
import { rewriteMessageImagesToProxy } from '../../../utils/asset_proxy_urls';

const getSessionMessagesHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };

		const url = new URL(request.url);
		const page = parseInt(url.searchParams.get('page') || '1', 10);
		const pageSize = parseInt(url.searchParams.get('pageSize') || '10', 10);

		if (page < 1 || pageSize < 1) {
			return error(400, 'page and pageSize must be positive integers');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.GOSTYLENS_DB);

		const session = await styleAnalysisDB.getSession(sessionId, request.user.dbId);
		if (!session) {
			return error(404, 'Session not found or access denied');
		}

		const { messages, total } = await styleAnalysisDB.getSessionMessages(sessionId, {
			page,
			pageSize,
		});
		const messagesWithProxyUrls = rewriteMessageImagesToProxy(messages, url.origin);
		const paginationMetadata = getPaginationMetadata(total, page, pageSize);

		return new Response(
			JSON.stringify({
				sessionId,
				sessionTitle: session.title,
				userId: session.user_id,
				messages: messagesWithProxyUrls,
				pagination: paginationMetadata,
			}),
			{
				headers: {
					'Content-Type': 'application/json',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				},
			}
		);
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default getSessionMessagesHandler;
