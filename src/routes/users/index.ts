import { Router } from 'itty-router';
import createUserHandler from './handlers/createUserHandler';
import deleteUserHandler from './handlers/deleteUserHandler';
import updateUserHandler from './handlers/updateUserHandler';
import getUserByAuthIdHandler from './handlers/getUserByAuthIdHandler';
import getUsersHandler from './handlers/getUsersHandler';

const router = Router({ base: '/users' });

router.post('/', createUserHandler);
router.get('/', getUsersHandler);
router.get('/auth/:authId', getUserByAuthIdHandler);
router.delete('/:userId', deleteUserHandler);
router.patch('/:userId', updateUserHandler);


export default router;
