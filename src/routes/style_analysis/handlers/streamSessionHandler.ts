import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { createStyleAnalysisService } from 'services/style_analysis.svc';
import { ProvisionedAuthRequest } from 'types';
import { ImageUploadTimeoutError } from 'utils/r2.utils';
import { apiError } from 'utils/error';

const streamSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };
		const url = new URL(request.url);

		const contextMode = (url.searchParams.get('contextMode') || 'recent') as 'all' | 'recent' | 'last';
		const recentCount = parseInt(url.searchParams.get('recentCount') || '10');

		const styleAnalysisDB = createStyleAnalysisDB(env.gostylens_db);
		const styleAnalysisService = createStyleAnalysisService(env);

		// Retrieve messages filtered by context mode, in chronological order
		const messages = await styleAnalysisService.getLLMContextSessionMessages({
			sessionId,
			userId: request.user.dbId,
			contextMode,
			recentCount
		});

		// Get streaming response
		const stream = await styleAnalysisService.generateStyleAdviceStream({
			sessionId,
			messages,
			onComplete: async (completeText) => {
				await styleAnalysisDB.addMessage({ role: 'assistant', sessionId, content: completeText });
			}
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
			const statusCode = err.message.includes('NOT_FOUND') ? 404 : 400;
			return error(statusCode, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default streamSessionHandler;
