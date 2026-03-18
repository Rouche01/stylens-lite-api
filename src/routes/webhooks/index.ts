import { Router } from 'itty-router';
import revenueCatWebhookHandler from './handlers/revenueCatWebhookHandler';

const router = Router({ base: '/webhooks' });

router.post('/revenuecat', revenueCatWebhookHandler);

export default router;
