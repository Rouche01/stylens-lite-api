import { Router } from 'itty-router';
import revenueCatWebhookHandler from './handlers/revenueCatWebhookHandler';
import emailWebhookHandler from './handlers/emailWebhookHandler';

const router = Router({ base: '/webhooks' });

router.post('/revenuecat', revenueCatWebhookHandler);
router.post('/email', emailWebhookHandler);

export default router;
