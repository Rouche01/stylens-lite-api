import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import getClosetItemsHandler from './handlers/getClosetItemsHandler';
import getClosetItemDetailsHandler from './handlers/getClosetItemDetailsHandler';
import deleteClosetItemHandler from './handlers/deleteClosetItemHandler';

const router = Router({ base: '/closet' });

// Mount endpoints under the /closet namespace, protected by auth and db midlewares
router.get('/items', authMiddleware, dbIdMiddleware, getClosetItemsHandler);
router.get('/items/:id', authMiddleware, dbIdMiddleware, getClosetItemDetailsHandler);
router.delete('/items/:id', authMiddleware, dbIdMiddleware, deleteClosetItemHandler);

export default router;
