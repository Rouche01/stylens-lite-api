import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { createLLMService } from 'services/llm.svc';
import { createClassificationService } from 'services/classification.svc';
import { MessageEntry } from 'utils/types';
import { ProvisionedAuthRequest } from 'types';
import { ImageUploadTimeoutError } from 'utils/r2.utils';
import { apiError } from 'utils/error';

const streamSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };
		const url = new URL(request.url);

		// New parameter to control context strategy
		const contextMode = url.searchParams.get('contextMode') || 'recent'; // 'all', 'recent', 'last'
		const recentCount = parseInt(url.searchParams.get('recentCount') || '10'); // Default to last 10 messages

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);
		const llmService = createLLMService();

		// Verify session exists
		const session = await styleAnalysisDB.getSession(sessionId, request.user.dbId);
		if (!session) {
			return error(404, 'Session not found or access denied');
		}

		// Get all session messages
		// TODO: implement pagination if needed
		const { messages: allMessages } = await styleAnalysisDB.getSessionMessages(sessionId);

		// Filter messages based on context mode
		let messagesToSend: typeof allMessages;

		switch (contextMode) {
			case 'all':
				// Send entire conversation history
				messagesToSend = allMessages;
				break;

			case 'last':
				// Send only the last user message
				const lastUserMessage = allMessages.find((msg) => msg.role === 'user');
				messagesToSend = lastUserMessage ? [lastUserMessage] : [];
				break;

			case 'recent':
			default:
				// Send last N messages (newest first in DESC, so take from start)
				messagesToSend = allMessages.slice(0, recentCount);
				break;
		}

		// Convert to MessageEntry format
		const messageEntries: MessageEntry[] = messagesToSend.map((m) => ({
			role: m.role as 'user' | 'assistant' | 'system',
			prompt: m.content || undefined,
			remoteImage: m.image_url || m.image_key ? { url: m?.image_url || '', key: m.image_key || '' } : undefined,
			remoteImages: m.images ? m.images.map(img => ({ url: img.url, key: img.key })) : undefined,
		}));

		// Prepare for LLM (Reverse to make it ASC for the AI)
		const preparedMessages = await llmService.prepareMessagesForLLM(messageEntries.reverse());

		// Get streaming response
		const stream = await llmService.generateStreamingResponse(sessionId, preparedMessages, async (completeText) => {
			const messageEntryId = await styleAnalysisDB.addMessage({ role: 'assistant', sessionId, content: completeText });

			// Trigger classification in the background for assistant's verdict
			const classificationService = createClassificationService(env.gostylens_db);
			classificationService.tagEntryInBackground(messageEntryId, { role: 'assistant', prompt: completeText }, (request as any).ctx, sessionId);
		});

		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	} catch (err) {
		if (err instanceof ImageUploadTimeoutError) {
			return apiError(408, err.message, 'IMAGE_UPLOAD_TIMEOUT');
		}
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default streamSessionHandler;
