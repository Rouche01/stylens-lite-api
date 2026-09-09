import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import extractOutfitHandler from './handlers/extractOutfitHandler';

const router = Router({ base: '/outfits' });

router.post('/extract', authMiddleware, dbIdMiddleware, extractOutfitHandler);

export default router;
