import { Router } from 'itty-router';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { authOrAdminMiddleware } from '../../middlewares/authOrAdminMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';
import { adminApiKeyMiddleware, adminApiKeyQueryMiddleware } from '../../middlewares/adminApiKeyMiddleware';
import { requireFeatureFlagMiddleware } from '../../middlewares/featureFlagMiddleware';
import { FeatureFlags } from '../../config/featureFlags';
import getClosetItemsHandler from './handlers/getClosetItemsHandler';
import getClosetItemDetailsHandler from './handlers/getClosetItemDetailsHandler';
import updateClosetItemHandler from './handlers/updateClosetItemHandler';
import deleteClosetItemHandler from './handlers/deleteClosetItemHandler';
import previewClosetItemHandler from './handlers/previewClosetItemHandler';
import embedClosetCropHandler from './handlers/embedClosetCropHandler';
import queryClosetCropHandler from './handlers/queryClosetCropHandler';
import getClosetIdentityStatusHandler from './handlers/getClosetIdentityStatusHandler';
import listPendingClosetMatchesHandler from './handlers/listPendingClosetMatchesHandler';
import resolveClosetMatchHandler from './handlers/resolveClosetMatchHandler';
import resetEvalUserHandler from './handlers/resetEvalUserHandler';

const requireClosetBrowse = requireFeatureFlagMiddleware(FeatureFlags.closetBrowse, {
	message: 'Closet is unavailable',
	code: 'CLOSET_UNAVAILABLE',
});

const router = Router({ base: '/closet' });

router.post('/identity/embed', adminApiKeyMiddleware, embedClosetCropHandler);
router.post('/identity/query', adminApiKeyMiddleware, queryClosetCropHandler);
/** Wipe EVAL_USER_ID closet/identity state between eval cycles. */
router.post('/eval/reset', adminApiKeyMiddleware, resetEvalUserHandler);
router.get(
	'/identity/status',
	authMiddleware,
	dbIdMiddleware,
	requireClosetBrowse,
	getClosetIdentityStatusHandler
);
router.get('/items/:id/preview', adminApiKeyQueryMiddleware, previewClosetItemHandler); // `?layout=closet` = padded tile vs person-centered native-aspect crop + dim
router.get('/items', authMiddleware, dbIdMiddleware, requireClosetBrowse, getClosetItemsHandler);
router.get('/items/:id', authMiddleware, dbIdMiddleware, requireClosetBrowse, getClosetItemDetailsHandler);
/** User display rename — updates `label` only; not used for identity matching. */
router.patch('/items/:id', authMiddleware, dbIdMiddleware, requireClosetBrowse, updateClosetItemHandler);
router.delete('/items/:id', authMiddleware, dbIdMiddleware, requireClosetBrowse, deleteClosetItemHandler);
router.get('/matches/pending', authOrAdminMiddleware, requireClosetBrowse, listPendingClosetMatchesHandler);
router.post('/matches/:id/resolve', authOrAdminMiddleware, requireClosetBrowse, resolveClosetMatchHandler);

export default router;
