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

export * from './auth';
