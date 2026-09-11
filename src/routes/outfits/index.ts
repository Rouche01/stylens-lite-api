import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';
import extractOutfitHandler from './handlers/extractOutfitHandler';
import generateCutoutHandler from './handlers/generateCutoutHandler';
import generateTryonHandler from './handlers/generateTryonHandler';

const router = Router({ base: '/outfits' });

router.post('/extract', authMiddleware, dbIdMiddleware, extractOutfitHandler);
router.post('/cutouts/generate', adminApiKeyMiddleware, generateCutoutHandler);
router.post('/tryon/generate', adminApiKeyMiddleware, generateTryonHandler);

export default router;
