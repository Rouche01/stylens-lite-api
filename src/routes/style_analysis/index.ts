import { Router } from 'itty-router';
import createSessionHandler from './handlers/createSessionHandler';
import streamSessionHandler from './handlers/streamSessionHandler';
import listSessionsHandler from './handlers/listSessionsHandler';
import deleteSessionHandler from './handlers/deleteSessionHandler';
import getSessionMessagesHandler from './handlers/getSessionMessagesHandler';
import addMessageToSessionHandler from './handlers/addMessageToSessionHandler';
import toggleSessionFavouriteHandler from './handlers/toggleSessionFavouriteHandler';
import updateSessionHandler from './handlers/updateSessionHandler';
import { authMiddleware } from '../../middlewares/authMiddleware';
import { dbIdMiddleware } from '../../middlewares/dbIdMiddleware';

const router = Router({ base: '/style-analysis' });

router.post('/sessions', authMiddleware, dbIdMiddleware, createSessionHandler);

// Streaming endpoint for assistant responses within a style analysis session
router.get('/sessions/:sessionId/stream', authMiddleware, dbIdMiddleware, streamSessionHandler);

router.get('/sessions', authMiddleware, dbIdMiddleware, listSessionsHandler);

router.delete('/sessions/:sessionId', authMiddleware, dbIdMiddleware, deleteSessionHandler);

router.get('/sessions/:sessionId/messages', authMiddleware, dbIdMiddleware, getSessionMessagesHandler);

router.post('/sessions/:sessionId/messages', authMiddleware, dbIdMiddleware, addMessageToSessionHandler);

router.patch('/sessions/:sessionId/favourite', authMiddleware, dbIdMiddleware, toggleSessionFavouriteHandler);

router.patch('/sessions/:sessionId', authMiddleware, dbIdMiddleware, updateSessionHandler);

export default router;
