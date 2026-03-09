import { Gender, SubscriptionTier } from 'types';
import { RemoteImage } from '../utils/types';

export type StyleAnalysisHistory = {
	id: string;
	user_id: string;
	title: string;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	is_deleted: 0 | 1;
	is_favourite?: boolean;
};

export type StyleAnalysisEntry = {
	id: string;
	style_analysis_history_id: string;
	role: 'user' | 'assistant' | 'system';
	content?: string;
	image_url?: string | null;
	image_key?: string | null;
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

export type User = {
	id: string;
	auth_id: string;
	name: string;
	gender?: Gender;
	email?: string;
	created_at: number;
	updated_at: number;
	is_active: 0 | 1;
	subscription?: Subscription;
};

export type Subscription = {
	id: string;
	user_id: string;
	tier: SubscriptionTier;
	provider: string | null;
	provider_customer_id: string | null;
	provider_subscription_id: string | null;
	status: string | null;
	current_period_end: number | null;
	created_at: number;
	updated_at: number;
};

export type CreateUserParams = {
	authId: string;
	name: string;
	gender?: Gender;
	email?: string;
};
