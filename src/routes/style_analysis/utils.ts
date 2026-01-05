import { MessageEntry } from 'utils/types';

export const isValidMessageEntry = (entry: MessageEntry) => {
	return entry.prompt || (entry.remoteImage && (entry.remoteImage.url || entry.remoteImage.key));
};
