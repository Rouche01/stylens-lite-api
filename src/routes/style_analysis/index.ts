import { Router } from 'itty-router';
import createSessionHandler from './handlers/createSessionHandler';
import streamSessionHandler from './handlers/streamSessionHandler';
import listSessionsHandler from './handlers/listSessionsHandler';
import deleteSessionHandler from './handlers/deleteSessionHandler';
import getSessionMessagesHandler from './handlers/getSessionMessagesHandler';
import addMessageToSessionHandler from './handlers/addMessageToSessionHandler';
import { authMiddleware } from '../../middlewares/authMiddleware';

const router = Router({ base: '/style-analysis' });

router.post('/sessions', authMiddleware, createSessionHandler);

// Streaming endpoint for assistant responses within a style analysis session
router.get('/sessions/:sessionId/stream', authMiddleware, streamSessionHandler);

router.get('/sessions', authMiddleware, listSessionsHandler);

router.delete('/sessions/:sessionId', authMiddleware, deleteSessionHandler);

router.get('/sessions/:sessionId/messages', authMiddleware, getSessionMessagesHandler);

router.post('/sessions/:sessionId/messages', authMiddleware, addMessageToSessionHandler);

export default router;
