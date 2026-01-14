import { Router } from 'itty-router';
import createUserHandler from './handlers/createUserHandler';
import deleteUserHandler from './handlers/deleteUserHandler';
import updateUserHandler from './handlers/updateUserHandler';

const router = Router({ base: '/users' });

router.post('/', createUserHandler);
router.delete('/:userId', deleteUserHandler);
router.patch('/:userId', updateUserHandler);

export default router;
