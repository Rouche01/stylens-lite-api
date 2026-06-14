import { error, RequestHandler } from 'itty-router';
import { createStyleAnalysisDB } from 'db';
import { env } from 'cloudflare:workers';
import { createStyleAnalysisService } from 'services/style_analysis.svc';
import { createPushService } from 'services/push.svc';
import { ProvisionedAuthRequest } from 'types';
import { ImageUploadTimeoutError } from 'utils/r2.utils';
import { apiError } from 'utils/error';

const streamSessionHandler: RequestHandler<ProvisionedAuthRequest> = async (request) => {
	try {
		const { sessionId } = request.params as { sessionId: string };
		const url = new URL(request.url);

		const contextMode = (url.searchParams.get('contextMode') || 'recent') as 'all' | 'recent' | 'last';
		const recentCount = parseInt(url.searchParams.get('recentCount') || '10');

		const styleAnalysisDB = createStyleAnalysisDB(env.GOSTYLENS_DB);
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
				// Save the assistant response in the D1 DB
				await styleAnalysisDB.addMessage({ role: 'assistant', sessionId, content: completeText });

				// Trigger FCM push notification to the user in the background (to test push notifications)
				const ctx = (request as any).ctx as ExecutionContext;
				const pushService = createPushService(env);
				pushService.sendPushNotificationInBackground(
					request.user.dbId,
					'Style Advice Ready',
					'Your personalized style advice is ready!',
					ctx,
					{ 'sessionId': sessionId, 'type': 'style_advice_ready' }
				);
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
