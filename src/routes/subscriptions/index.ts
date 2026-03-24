import { Router } from 'itty-router';
import getSubscriptionByUserIdHandler from './handlers/getSubscriptionByUserIdHandler';
import updateSubscriptionHandler from './handlers/updateSubscriptionHandler';
import resetSubscriptionLimitHandler from './handlers/resetSubscriptionLimitHandler';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';

const router = Router({ base: '/subscriptions' });

router.get('/:userId', authMiddleware, dbIdMiddleware, getSubscriptionByUserIdHandler);
router.patch('/:userId', authMiddleware, dbIdMiddleware, updateSubscriptionHandler);
router.post('/reset', adminApiKeyMiddleware, resetSubscriptionLimitHandler);

export default router;
