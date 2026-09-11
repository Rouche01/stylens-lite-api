import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import { adminApiKeyQueryMiddleware } from '../../middlewares/adminApiKeyMiddleware';
import getClosetItemsHandler from './handlers/getClosetItemsHandler';
import getClosetItemDetailsHandler from './handlers/getClosetItemDetailsHandler';
import deleteClosetItemHandler from './handlers/deleteClosetItemHandler';
import previewClosetItemHandler from './handlers/previewClosetItemHandler';

const router = Router({ base: '/closet' });

router.get('/items/:id/preview', adminApiKeyQueryMiddleware, previewClosetItemHandler);
router.get('/items', authMiddleware, dbIdMiddleware, getClosetItemsHandler);
router.get('/items/:id', authMiddleware, dbIdMiddleware, getClosetItemDetailsHandler);
router.delete('/items/:id', authMiddleware, dbIdMiddleware, deleteClosetItemHandler);

export default router;
