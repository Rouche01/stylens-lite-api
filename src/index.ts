import { error, Router } from 'itty-router';
import styleAnalysisRouter from './routes/style_analysis';
import assetsRouter from './routes/assets';
import usersRouter from './routes/users';
import outfitsRouter from './routes/outfits';
import favouritesRouter from './routes/favourites';

const router = Router();

// Mount the style analysis router at the /style-analysis path
router.all('/style-analysis/*', styleAnalysisRouter.fetch);
router.all('/assets/*', assetsRouter.fetch);
router.all('/users/*', usersRouter.fetch); // Mount users router
router.all('/outfits/*', outfitsRouter.fetch);
router.all('/favourites/*', favouritesRouter.fetch);

router.get('/', () => new Response('Style Analysis API is running'));

// Add a catch-all for unmatched routes
router.all('*', () => error(404));

export default {
	async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
		// Attach ctx to request for access in routes
		(request as any).ctx = ctx;
		return router.fetch(request, env, ctx);
	},
};
