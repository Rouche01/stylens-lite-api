import { Router } from 'itty-router';
import getSubscriptionByUserIdHandler from './handlers/getSubscriptionByUserIdHandler';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router({ base: '/subscriptions' });

router.get('/:userId', authMiddleware, getSubscriptionByUserIdHandler);

export default router;
