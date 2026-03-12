import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import listFavouritesHandler from './handlers/listFavouritesHandler';

const router = Router({ base: '/favourites' });

router.get('/', authMiddleware, dbIdMiddleware, listFavouritesHandler);

export default router;
