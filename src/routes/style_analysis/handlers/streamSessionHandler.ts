import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { createLLMService } from 'utils/llm.utils';

const streamSessionHandler: RequestHandler = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };
		const url = new URL(request.url);
		const userId = url.searchParams.get('userId');

		// New parameter to control context strategy
		const contextMode = url.searchParams.get('contextMode') || 'recent'; // 'all', 'recent', 'last'
		const recentCount = parseInt(url.searchParams.get('recentCount') || '10'); // Default to last 10 messages

		if (!userId) {
			return error(400, 'userId query parameter is required');
		}

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);
		const llmService = createLLMService();

		// Verify session exists
		const session = await styleAnalysisDB.getSession(sessionId, userId);
		if (!session) {
			return error(404, 'Session not found or access denied');
		}

		// Get all session messages
		// TODO: implement pagination if needed
		const allMessages = await styleAnalysisDB.getSessionMessages(sessionId);

		// Filter messages based on context mode
		let messagesToSend: typeof allMessages;

		switch (contextMode) {
			case 'all':
				// Send entire conversation history
				messagesToSend = allMessages;
				break;

			case 'last':
				// Send only the last user message
				const lastUserMessage = [...allMessages].reverse().find((msg) => msg.role === 'user');
				messagesToSend = lastUserMessage ? [lastUserMessage] : [];
				break;

			case 'recent':
			default:
				// Send last N messages (recommended for balance)
				messagesToSend = allMessages.slice(-recentCount);
				break;
		}

		// Convert to MessageEntry format
		const messageEntries = messagesToSend.map((m) => ({
			role: m.role as 'user' | 'assistant' | 'system',
			prompt: m.content || undefined,
			imageUrl: m.remoteImage,
		}));

		// Prepare for LLM
		const preparedMessages = await llmService.prepareMessagesForLLM(messageEntries);

		// Get streaming response
		const stream = await llmService.generateStreamingResponse(preparedMessages);

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	} catch (err) {
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default streamSessionHandler;
