import { Router } from 'itty-router';
import createSessionHandler from './handlers/createSessionHandler';
import streamSessionHandler from './handlers/streamSessionHandler';
import listSessionsHandler from './handlers/listSessionsHandler';
import deleteSessionHandler from './handlers/deleteSessionHandler';
import getSessionMessagesHandler from './handlers/getSessionMessagesHandler';

const router = Router({ base: '/style-analysis' });

router.post('/sessions', createSessionHandler);

// Streaming endpoint for assistant responses within a style analysis session
router.get('/sessions/:sessionId/stream', streamSessionHandler);

router.get('/sessions', listSessionsHandler);

router.delete('/sessions/:sessionId', deleteSessionHandler);

router.get('/sessions/:sessionId/messages', getSessionMessagesHandler);

export default router;
