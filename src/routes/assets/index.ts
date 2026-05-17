import { Router } from 'itty-router';
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';
import getUploadUrlHandler from './handlers/getUploadUrlHandler';
import getDownloadUrlHandler from './handlers/getDownloadUrlHandler';
import getIsolatedItemHandler from './handlers/getIsolatedItemHandler';

const client = new AwsClient({
	accessKeyId: env.OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID,
	secretAccessKey: env.OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY,
});

const router = Router({ base: '/assets' });
const bucketName = env.OUTFIT_PHOTOS_BUCKET_NAME;
const accountId = env.R2_ACCOUNT_ID;

router.get('/upload-url', getUploadUrlHandler({ client, bucketName, accountId }));

router.get('/download-url', getDownloadUrlHandler({ client, bucketName, accountId }));

router.get('/isolate', getIsolatedItemHandler);

export default router;
