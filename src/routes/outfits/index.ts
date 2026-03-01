import { Router } from 'itty-router';
import analyzeOutfitHandler from './handlers/analyzeOutfitHandler';

const router = Router({ base: '/outfits' });

router.post('/analyze', analyzeOutfitHandler);

export default router;
