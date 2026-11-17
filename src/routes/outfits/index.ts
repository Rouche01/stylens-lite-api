import { Router } from 'itty-router';
import { authOrAdminMiddleware } from '../../middlewares/authOrAdminMiddleware';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';
import extractOutfitHandler from './handlers/extractOutfitHandler';
import generateCutoutHandler from './handlers/generateCutoutHandler';
import generateTryonHandler from './handlers/generateTryonHandler';
import searchCatalogHandler from './handlers/searchCatalogHandler';

const router = Router({ base: '/outfits' });

router.post('/extract', authOrAdminMiddleware, extractOutfitHandler);
router.post('/cutouts/generate', adminApiKeyMiddleware, generateCutoutHandler);
router.post('/tryon/generate', adminApiKeyMiddleware, generateTryonHandler);
router.post('/catalog/search', adminApiKeyMiddleware, searchCatalogHandler);

export default router;
