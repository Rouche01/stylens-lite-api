import { Router } from 'itty-router';
import createUserHandler from './handlers/createUserHandler';
import deleteUserHandler from './handlers/deleteUserHandler';
import updateUserHandler from './handlers/updateUserHandler';
import getUserByAuthIdHandler from './handlers/getUserByAuthIdHandler';
import getUsersHandler from './handlers/getUsersHandler';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';

const router = Router({ base: '/users' });

router.post('/', createUserHandler);
router.get('/', adminApiKeyMiddleware, getUsersHandler);
router.get('/auth/:authId', getUserByAuthIdHandler);
router.delete('/:userId', deleteUserHandler);
router.patch('/:userId', updateUserHandler);


export default router;
