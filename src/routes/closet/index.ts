import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { authOrAdminMiddleware } from '../../middlewares/authOrAdminMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import { adminApiKeyMiddleware, adminApiKeyQueryMiddleware } from '../../middlewares/adminApiKeyMiddleware';
import getClosetItemsHandler from './handlers/getClosetItemsHandler';
import getClosetItemDetailsHandler from './handlers/getClosetItemDetailsHandler';
import deleteClosetItemHandler from './handlers/deleteClosetItemHandler';
import previewClosetItemHandler from './handlers/previewClosetItemHandler';
import embedClosetCropHandler from './handlers/embedClosetCropHandler';
import queryClosetCropHandler from './handlers/queryClosetCropHandler';
import listPendingClosetMatchesHandler from './handlers/listPendingClosetMatchesHandler';
import resolveClosetMatchHandler from './handlers/resolveClosetMatchHandler';

const router = Router({ base: '/closet' });

router.post('/identity/embed', adminApiKeyMiddleware, embedClosetCropHandler);
router.post('/identity/query', adminApiKeyMiddleware, queryClosetCropHandler);
router.get('/items/:id/preview', adminApiKeyQueryMiddleware, previewClosetItemHandler); // `?layout=closet` = padded tile vs person-centered native-aspect crop + dim
router.get('/items', authMiddleware, dbIdMiddleware, getClosetItemsHandler);
router.get('/items/:id', authMiddleware, dbIdMiddleware, getClosetItemDetailsHandler);
router.delete('/items/:id', authMiddleware, dbIdMiddleware, deleteClosetItemHandler);
router.get('/matches/pending', authOrAdminMiddleware, listPendingClosetMatchesHandler);
router.post('/matches/:id/resolve', authOrAdminMiddleware, resolveClosetMatchHandler);

export default router;
