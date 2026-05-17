import { Router } from 'itty-router';
import extractOutfitHandler from './handlers/extractOutfitHandler';

const router = Router({ base: '/outfits' });

router.post('/extract', extractOutfitHandler);

export default router;
