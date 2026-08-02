import { Router } from 'itty-router';
import createUserHandler from './handlers/createUserHandler';
import deleteUserHandler from './handlers/deleteUserHandler';
import updateUserHandler from './handlers/updateUserHandler';
import getUserByAuthIdHandler from './handlers/getUserByAuthIdHandler';
import getUsersHandler from './handlers/getUsersHandler';
import updateUserLimitHandler from './handlers/updateUserLimitHandler';
import createInviteCodeHandler from './handlers/createInviteCodeHandler';
import listInviteCodesHandler from './handlers/listInviteCodesHandler';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';
import { authMiddleware } from 'middlewares/authMiddleware';
import { dbIdMiddleware } from 'middlewares/dbIdMiddleware';
import upsertPushTokenHandler from './handlers/upsertPushTokenHandler';
import deletePushTokenHandler from './handlers/deletePushTokenHandler';
import sendPushNotificationHandler from './handlers/sendPushNotificationHandler';

const router = Router({ base: '/users' });

router.post('/', authMiddleware, createUserHandler);
router.get('/', adminApiKeyMiddleware, getUsersHandler);
router.post('/limits', adminApiKeyMiddleware, updateUserLimitHandler);
router.post('/invite-codes', adminApiKeyMiddleware, createInviteCodeHandler);
router.get('/invite-codes', adminApiKeyMiddleware, listInviteCodesHandler);
router.post('/push-notification', adminApiKeyMiddleware, sendPushNotificationHandler);
// We don't need dbIdMiddleware, as long as user is in authSvc
// we can allow them access this route
router.get('/auth/:authId', authMiddleware, getUserByAuthIdHandler);
router.delete('/:userId', authMiddleware, dbIdMiddleware, deleteUserHandler);
router.patch('/:userId', authMiddleware, dbIdMiddleware, updateUserHandler);
router.put('/push-token', authMiddleware, dbIdMiddleware, upsertPushTokenHandler);
router.delete('/push-token/:token', authMiddleware, dbIdMiddleware, deletePushTokenHandler);


export default router;
