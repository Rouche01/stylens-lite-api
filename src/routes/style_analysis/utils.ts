import { MessageEntry } from 'utils/types';

export const isValidMessageEntry = (entry: MessageEntry) => {
	const hasPrompt = !!entry.prompt && entry.prompt.trim().length > 0;
	const hasRemoteImage = !!entry.remoteImage && (!!entry.remoteImage.url || !!entry.remoteImage.key);
	const hasRemoteImages = Array.isArray(entry.remoteImages) && entry.remoteImages.length > 0 && 
							entry.remoteImages.every(img => !!img.url || !!img.key);
	
	return hasPrompt || hasRemoteImage || hasRemoteImages;
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
