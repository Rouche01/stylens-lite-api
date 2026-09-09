import { error, Router } from 'itty-router';
import { loggingMiddleware } from './middlewares/loggingMiddleware';
import styleAnalysisRouter from './routes/style_analysis';
import assetsRouter from './routes/assets';
import usersRouter from './routes/users';
import outfitsRouter from './routes/outfits';
import favouritesRouter from './routes/favourites';
import subscriptionsRouter from './routes/subscriptions';
import webhooksRouter from './routes/webhooks';
import closetRouter from './routes/closet';
import configRouter from './routes/config';
import emailRouter from './routes/email';
import { createLogger } from './utils/logger.utils';
import { apiError } from './utils/error';
import { createPostHogSink } from './services/posthog.svc';
import { runActivationD0Job } from './jobs/activation_d0';
import type { ApiRequest } from './types';

const router = Router();

router.all('*', loggingMiddleware);

// Mount the style analysis router at the /style-analysis path
router.all('/style-analysis/*', styleAnalysisRouter.fetch);
router.all('/assets/*', assetsRouter.fetch);
router.all('/users/*', usersRouter.fetch); // Mount users router
router.all('/outfits/*', outfitsRouter.fetch);
router.all('/closet/*', closetRouter.fetch);
router.all('/favourites/*', favouritesRouter.fetch);
router.all('/subscriptions/*', subscriptionsRouter.fetch);
router.all('/webhooks/*', webhooksRouter.fetch);
router.all('/config/*', configRouter.fetch);
router.all('/email/*', emailRouter.fetch);

router.get('/', () => new Response('Style Analysis API is running'));

// Add a catch-all for unmatched routes
router.all('*', () => error(404));

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		(request as any).ctx = ctx;

		const url = new URL(request.url);
		const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
		const sessionId = request.headers.get('X-PostHog-Session-Id') ?? undefined;
		const sink = createPostHogSink(env);
		const log = createLogger({
			env: env.ENV_NAME,
			sink,
			context: {
				request_id: requestId,
				method: request.method,
				path: url.pathname,
				...(sessionId ? { sessionId } : {}),
			},
		});

		const apiRequest = request as ApiRequest;
		apiRequest.log = log;

		let response: Response;

		try {
			response = await router.fetch(request, env, ctx);
		} catch (err) {
			log.error('unhandled_request_error', { status: 500 }, err);
			response = apiError(500, 'Internal Server Error');
		}

		sink?.flush(ctx);
		return response;
	},

	async scheduled(
		controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		const sink = createPostHogSink(env);
		const log = createLogger({
			env: env.ENV_NAME,
			sink,
			context: {
				handler: 'scheduled',
				cron: controller.cron,
			},
		});

		try {
			// Single lifecycle cron today; local probes may pass a different cron string.
			await runActivationD0Job(env, ctx, log);
		} catch (err) {
			log.error('scheduled_handler_failed', { cron: controller.cron }, err);
			throw err;
		} finally {
			sink?.flush(ctx);
		}
	},
};
