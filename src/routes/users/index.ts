import { Router } from 'itty-router';
import createUserHandler from './handlers/createUserHandler';
import deleteUserHandler from './handlers/deleteUserHandler';
import updateUserHandler from './handlers/updateUserHandler';
import getUserByAuthIdHandler from './handlers/getUserByAuthIdHandler';
import getUsersHandler from './handlers/getUsersHandler';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';
import { authMiddleware } from 'middlewares/authMiddleware';
import { dbIdMiddleware } from 'middlewares/dbIdMiddleware';

const router = Router({ base: '/users' });

router.post('/', authMiddleware, createUserHandler);
router.get('/', adminApiKeyMiddleware, getUsersHandler);
// We don't need dbIdMiddleware, as long as user is in authSvc
// we can allow them access this route
router.get('/auth/:authId', authMiddleware, getUserByAuthIdHandler);
router.delete('/:userId', authMiddleware, dbIdMiddleware, deleteUserHandler);
router.patch('/:userId', authMiddleware, dbIdMiddleware, updateUserHandler);


export default router;
