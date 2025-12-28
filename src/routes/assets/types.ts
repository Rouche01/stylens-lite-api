import { AwsClient } from 'aws4fetch';

export type AssetConfig = {
	client: AwsClient;
	bucketName: string;
	accountId: string;
};
