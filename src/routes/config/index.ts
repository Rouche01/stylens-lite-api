import { Router } from 'itty-router';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';
import { authMiddleware } from 'middlewares/authMiddleware';
import getStylistOpenersHandler from './handlers/getStylistOpenersHandler';
import putStylistOpenersHandler from './handlers/putStylistOpenersHandler';
import getFeaturesHandler from './handlers/getFeaturesHandler';
import postFeaturesRefreshHandler from './handlers/postFeaturesRefreshHandler';

const router = Router({ base: '/config' });

router.get('/features', authMiddleware, getFeaturesHandler);
router.post('/features/refresh', adminApiKeyMiddleware, postFeaturesRefreshHandler);
router.get('/stylist-openers', authMiddleware, getStylistOpenersHandler);
router.put('/stylist-openers', adminApiKeyMiddleware, putStylistOpenersHandler);

export default router;
