import { env } from 'cloudflare:workers';
import { AvatarImageProvider } from './base.provider';
import { OpenAIAvatarImageProvider } from './openai.provider';

export function createAvatarImageProvider(envBindings: Env = env): AvatarImageProvider {
	const name = (envBindings.AVATAR_IMAGE_PROVIDER || 'openai').toLowerCase();

	switch (name) {
		case 'openai':
			return new OpenAIAvatarImageProvider(
				envBindings.OPENAI_MODEL_ENDPOINT_URL,
				envBindings.OPENAI_MODEL_API_KEY,
				envBindings.OPENAI_IMAGE_MODEL_VERSION || 'gpt-image-1'
			);
		default:
			throw new Error(`Unsupported AVATAR_IMAGE_PROVIDER: ${name}`);
	}
}

export type { AvatarImageProvider, GenerateTwinResult } from './base.provider';
export { AvatarImageError } from './base.provider';
export { OpenAIAvatarImageProvider } from './openai.provider';
