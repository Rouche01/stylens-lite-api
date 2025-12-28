import { RemoteImage } from '../utils/types';

export type StyleAnalysisHistory = {
	id: string;
	user_id: string;
	title: string;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	is_deleted: 0 | 1;
};

export type StyleAnalysisEntry = {
	id: string;
	style_analysis_history_id: string;
	role: 'user' | 'assistant' | 'system';
	content?: string;
	remoteImage?: RemoteImage;
	created_at: number;
};

export type CreateSessionParams = {
	userId: string;
	title?: string;
	messages: Array<{ remoteImage?: RemoteImage; prompt?: string; role: 'user' | 'assistant' | 'system' }>;
};

export type CreateSessionResult = {
	sessionId: string;
	title: string;
	messageIds: string[];
};

export type AddMessageParams = {
	sessionId: string;
	role: 'user' | 'assistant' | 'system';
	content?: string;
	remoteImage?: RemoteImage;
};
