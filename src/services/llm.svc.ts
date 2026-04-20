import { env } from 'cloudflare:workers';
import { LLMContentItem, LLMInput, LLMOutputContentItem, LLMProviderInput, LLMResponse, MessageEntry } from '../utils/types';
import { regenerateSignedUrl } from '../utils/assets.utils';
import { waitForImages } from '../utils/r2.utils';
import { ModelUseCase, ModelConfigService, ModelProvider } from './model_config.svc';
import { ILLMProvider } from './llm/providers/base.provider';
import { OpenAIProvider } from './llm/providers/openai.provider';
import { ClaudeProvider } from './llm/providers/claude.provider';

export class LLMService {
	constructor(
		private provider: ILLMProvider,
		private bucket?: R2Bucket
	) { }
	async generateResponse(
		input: LLMProviderInput,
		signal?: AbortSignal,
		format?: { type: 'json_schema' | 'text' | 'json_object'; name?: string; schema?: object },
		model?: string,
	): Promise<LLMOutputContentItem[]> {
		return this.provider.generateResponse({ input, format, signal, model });
	}

	async generateStreamingResponse(
		sessionId: string,
		input: LLMProviderInput,
		onComplete?: (completeStreamText: string) => Promise<void> | void,
		signal?: AbortSignal,
		model?: string,
	): Promise<ReadableStream> {
		return this.provider.generateStreamingResponse({ sessionId, input, onComplete, signal, model });
	}

	messageEntryToLLMInput(entry: MessageEntry): LLMInput {
		const content: Array<LLMContentItem> = [];

		if (entry.prompt) {
			content.push({ type: 'input_text' as const, text: entry.prompt });
		}

		if (entry.remoteImage) {
			content.push({ type: 'input_image' as const, image_url: entry.remoteImage.url });
		}

		if (entry.remoteImages && entry.remoteImages.length > 0) {
			for (const img of entry.remoteImages) {
				// Avoid duplication if the same image is in both
				if (!entry.remoteImage || entry.remoteImage.url !== img.url) {
					content.push({ type: 'input_image' as const, image_url: img.url });
				}
			}
		}

		return {
			role: 'user',
			content,
		};
	}

	// Convenience method for single message
	async generateAssistantResponse(userMessage: MessageEntry): Promise<any> {
		const preparedInput = await this.prepareMessagesForLLM([userMessage]);
		return this.generateResponse(preparedInput);
	}

	// Process initial style analysis session messages for LLM input
	// Process initial style analysis session messages for LLM input
	async prepareMessagesForLLM(messages: MessageEntry[]): Promise<LLMProviderInput> {
		// 1. Collect all unique image keys for polling (common across providers)
		if (this.bucket) {
			const uniqueKeys = new Set<string>();
			for (const msg of messages) {
				if (msg.role === 'user') {
					if (msg.remoteImage?.key) uniqueKeys.add(msg.remoteImage.key);
					if (msg.remoteImages) {
						for (const img of msg.remoteImages) {
							if (img.key) uniqueKeys.add(img.key);
						}
					}
				}
			}

			if (uniqueKeys.size > 0) {
				await waitForImages(this.bucket, Array.from(uniqueKeys));
			}
		}

		// 2. Delegate provider-specific transformation
		return this.provider.prepareMessagesForLLM(messages);
	}
}

type LLMServiceOpts = Partial<{
	endpoint: string;
	apiKey: string;
	model: string;
	bucket: R2Bucket;
	useCase: ModelUseCase;
	provider: ModelProvider;
}>;

export const createLLMService = (opts?: LLMServiceOpts): LLMService => {
	let endpoint = opts?.endpoint || env.OPENAI_MODEL_ENDPOINT_URL;
	let apiKey = opts?.apiKey || env.OPENAI_MODEL_API_KEY;
	let model = opts?.model || env.OPENAI_FAST_TASK_MODEL_VERSION;
	let bucket = opts?.bucket || env.OUTFIT_PHOTOS_BUCKET;
	let providerType = opts?.provider || ModelProvider.OPENAI;

	if (opts?.useCase) {
		const configService = new ModelConfigService(opts?.provider);
		const config = configService.getConfig(opts.useCase);
		endpoint = opts.endpoint ?? config.endpoint;
		apiKey = opts.apiKey ?? config.apiKey;
		model = opts.model ?? config.model;
		bucket = opts.bucket ?? config.bucket ?? env.OUTFIT_PHOTOS_BUCKET;
		providerType = config.provider;
	}

	const provider = providerType === ModelProvider.CLAUDE
		? new ClaudeProvider(endpoint, apiKey, model)
		: new OpenAIProvider(endpoint, apiKey, model);

	return new LLMService(
		provider,
		bucket
	);
};
