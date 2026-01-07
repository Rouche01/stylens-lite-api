import { MessageEntry } from 'utils/types';

export const isValidMessageEntry = (entry: MessageEntry) => {
	return entry.prompt || (entry.remoteImage && (entry.remoteImage.url || entry.remoteImage.key));
};

export const getPaginationMetadata = (totalItems: number, page: number, pageSize: number) => {
	const totalPages = Math.ceil(totalItems / pageSize);
	return {
		page,
		pageSize,
		totalPages,
		totalItems,
		hasNextPage: page < totalPages,
		hasPreviousPage: page > 1,
	};
};
