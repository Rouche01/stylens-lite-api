import { error, RequestHandler } from 'itty-router';
import { MessageEntry } from 'utils/types';
import { isValidMessageEntry } from '../utils';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';

type AddMessageToSessionBody = {
	userId: string;
	message: MessageEntry;
};

const addMessageToSessionHandler: RequestHandler = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };
		const body = (await request.json()) as AddMessageToSessionBody;

		if (!body.message) {
			return error(400, 'A message is required to add to the session');
		}

		if (!isValidMessageEntry(body.message)) {
			return error(400, 'The message must contain either text content or an image');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);

		// First, verify session exists and belongs to user
		const session = await styleAnalysisDB.getSession(sessionId, body.userId);
		if (!session) {
			return error(404, 'Session not found or access denied');
		}

		const messageEntryId = await styleAnalysisDB.addMessage({
			sessionId,
			role: body.message.role,
			content: body.message.prompt,
			remoteImage: body.message.remoteImage,
		});

		return new Response(JSON.stringify({ sessionId: sessionId, messageId: messageEntryId }), {
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default addMessageToSessionHandler;
