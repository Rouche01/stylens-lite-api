import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import listFavouritesHandler from './handlers/listFavouritesHandler';

const router = Router({ base: '/favourites' });

router.get('/', authMiddleware, listFavouritesHandler);

export default router;
