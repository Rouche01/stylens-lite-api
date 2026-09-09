import { Router } from 'itty-router';
import { adminApiKeyMiddleware } from 'middlewares/adminApiKeyMiddleware';
import unsubscribeEmailHandler from './handlers/unsubscribeEmailHandler';
import testSendEmailHandler from './handlers/testSendEmailHandler';

const router = Router({ base: '/email' });

router.get('/unsubscribe', unsubscribeEmailHandler);
router.post('/unsubscribe', unsubscribeEmailHandler);
router.post('/test-send', adminApiKeyMiddleware, testSendEmailHandler);

export default router;
