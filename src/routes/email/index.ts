import { Router } from 'itty-router';
import unsubscribeEmailHandler from './handlers/unsubscribeEmailHandler';

const router = Router({ base: '/email' });

router.get('/unsubscribe', unsubscribeEmailHandler);
router.post('/unsubscribe', unsubscribeEmailHandler);

export default router;
