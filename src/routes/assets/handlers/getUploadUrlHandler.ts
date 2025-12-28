import { error, RequestHandler } from 'itty-router';
import { AssetConfig } from '../types';

const getUploadUrlHandler: (config: AssetConfig) => RequestHandler = ({ client, bucketName, accountId }) => {
	return async ({ query }) => {
		if (typeof query.filename !== 'string') {
			return error(400, '`filename` query param is required');
		}

		const modifiedFilename = `${crypto.randomUUID()}-${query.filename}`;

		// Generate upload URL
		const uploadUrl = new URL(`https://${bucketName}.${accountId}.r2.cloudflarestorage.com`);
		uploadUrl.pathname = `/${modifiedFilename}`;
		uploadUrl.searchParams.set('X-Amz-Expires', '3600');
		const presignedUpload = await client.sign(new Request(uploadUrl, { method: 'PUT' }), { aws: { signQuery: true } });

		// Generate download URL
		const downloadUrl = new URL(`https://${bucketName}.${accountId}.r2.cloudflarestorage.com`);
		downloadUrl.pathname = `/${modifiedFilename}`;
		downloadUrl.searchParams.set('X-Amz-Expires', '3600');
		const presignedDownload = await client.sign(new Request(downloadUrl, { method: 'GET' }), { aws: { signQuery: true } });

		return new Response(
			JSON.stringify({
				uploadUrl: presignedUpload.url,
				downloadUrl: presignedDownload.url,
				filename: modifiedFilename,
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	};
};

export default getUploadUrlHandler;
