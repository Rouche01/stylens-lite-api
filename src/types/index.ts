export type PaginationParams = {
	page: number;
	pageSize: number;
};

export enum Gender {
	Male = 'male',
	Female = 'female',
	NonBinary = 'non-binary',
	Unspecified = 'unspecified',
}

export enum SubscriptionTier {
	Free = 'free',
	Core = 'core',
}

export * from './auth';
