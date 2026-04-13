import { error, RequestHandler } from 'itty-router';
import { MessageEntry } from 'utils/types';
import { isValidMessageEntry } from '../utils';
import { env } from 'cloudflare:workers';
import { ProvisionedAuthRequest } from 'types';
import { createStyleAnalysisService } from 'services/style_analysis.svc';

type AddMessageToSessionBody = {
	message: MessageEntry;
};

const addMessageToSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };
		const body = (await request.json()) as AddMessageToSessionBody;

		if (!body.message) {
			return error(400, 'A message is required to add to the session');
		}

		if (!isValidMessageEntry(body.message)) {
			return error(400, 'The message must contain either text content or an image');
		}

		const ctx = (request as any).ctx as ExecutionContext;
		const styleAnalysisService = createStyleAnalysisService(env);

		const result = await styleAnalysisService.addMessageToSession({
			sessionId,
			userId: request.user.dbId,
			message: body.message,
			ctx
		});

		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		if (err instanceof Error) {
			const statusCode = err.message.includes('NOT_FOUND') ? 404 : 400;
			return error(statusCode, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default addMessageToSessionHandler;
