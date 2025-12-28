import { error, RequestHandler } from 'itty-router';
import { AssetConfig } from '../types';

const getDownloadUrlHandler: (config: AssetConfig) => RequestHandler = ({ client, bucketName, accountId }) => {
	return async ({ query }) => {
		if (typeof query.filename !== 'string') {
			return error(400, '`filename` query param is required');
		}

		const url = new URL(`https://${bucketName}.${accountId}.r2.cloudflarestorage.com`);
		url.pathname = `/${query.filename}`;
		url.searchParams.set('X-Amz-Expires', '3600');

		const presigned = await client.sign(new Request(url, { method: 'GET' }), { aws: { signQuery: true } });

		return new Response(presigned.url);
	};
};

export default getDownloadUrlHandler;
