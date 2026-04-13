import { MessageEntry } from 'utils/types';
import { error, RequestHandler } from 'itty-router';
import { isValidMessageEntry } from '../utils';
import { ProvisionedAuthRequest } from 'types';
import { createStyleAnalysisService } from 'services/style_analysis.svc';
import { env } from 'cloudflare:workers';

type CreateSessionBody = {
	title?: string;
	messages: MessageEntry[];
};

const createSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const body = (await request.json()) as CreateSessionBody;

		if (!body.messages || body.messages.length === 0) {
			return error(400, 'At least one message is required to create a session');
		}

		// Validate messages
		const isValidMessages = body.messages.some((msg) => msg.role === 'user' && isValidMessageEntry(msg));

		if (!isValidMessages) {
			return error(400, 'At least one valid user message with content or image is required to create a session');
		}

		const ctx = (request as any).ctx as ExecutionContext;
		const styleAnalysisService = createStyleAnalysisService(env);

		const sessionResult = await styleAnalysisService.createSession({
			userId: request.user.dbId,
			messages: body.messages,
			title: body.title,
			ctx
		});

		return new Response(
			JSON.stringify(sessionResult),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (err) {
		if (err instanceof Error) {
			const statusCode = err.message.includes('FREE_LIMIT_REACHED') ? 403 : 400;
			return error(statusCode, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default createSessionHandler;
