import { ClaudeContentBlock, ClaudeLLMInput, ClaudeMessage, ClaudeSystemPrompt, LLMOutputContentItem, MessageEntry } from '../../../utils/types';
import { regenerateSignedUrl } from '../../../utils/assets.utils';
import { ILLMProvider } from './base.provider';
import { handleSSEStream } from '../../../utils/llm_stream.utils';

export class ClaudeProvider implements ILLMProvider {
	constructor(
		private endpoint: string,
		private apiKey: string,
		private model: string
	) { }

	async prepareMessagesForLLM(messages: MessageEntry[]): Promise<ClaudeLLMInput> {
		const processedMessages: ClaudeMessage[] = [];
		let systemPrompt: ClaudeSystemPrompt | undefined = undefined;

		for (const message of messages) {
			if (message.role === 'system') {
				// Claude uses a separate system parameter
				if (message.prompt) {
					systemPrompt = message.prompt;
				}
				continue;
			}

			const role = message.role === 'user' ? 'user' : 'assistant';
			const content: ClaudeContentBlock[] = [];

			if (message.prompt) {
				content.push({ type: 'text', text: message.prompt });
			}

			// Handle images
			const images = [
				...(message.remoteImage ? [message.remoteImage] : []),
				...(message.remoteImages || [])
			];

			// Deduplicate if necessary (though remoteImages should already be clean)
			const uniqueImages = Array.from(new Map(images.map(img => [img.url, img])).values());

			for (const img of uniqueImages) {
				const freshSignedUrl = await regenerateSignedUrl(img.url);
				content.push({
					type: 'image',
					source: {
						type: 'url',
						url: freshSignedUrl,
					}
				});
			}

			processedMessages.push({
				role,
				content: content.length === 1 && content[0].type === 'text' ? (content[0] as any).text : content,
			});
		}

		return {
			messages: processedMessages,
			system: systemPrompt,
		};
	}

	private getBaseHeaders() {
		return {
			'Content-Type': 'application/json',
			'x-api-key': this.apiKey,
			'anthropic-version': '2023-06-01',
		};
	}

	async generateResponse(params: {
		input: ClaudeLLMInput;
		format?: { type: 'json_schema' | 'text' | 'json_object'; name?: string; schema?: object };
		signal?: AbortSignal;
		model?: string;
	}): Promise<LLMOutputContentItem[]> {
		const { input, format, signal, model } = params;
		const response = await fetch(`${this.endpoint}/messages`, {
			method: 'POST',
			headers: this.getBaseHeaders(),
			body: JSON.stringify({
				model: model || this.model,
				messages: input.messages,
				system: input.system,
				max_tokens: 1024,
				...(format?.type === 'json_schema' ? {
					// Handle JSON schema if supported by the specific Claude endpoint/wrapper
					// For standard Anthropic, this might need different handling
				} : {})
			}),
			signal,
		});
		console.log(response, 'response from claude');
		console.log('ClaudeProvider.generateResponse called with model:', model || this.model);
		throw new Error('ClaudeProvider not fully implemented yet');
	}

	async generateStreamingResponse(params: {
		sessionId: string;
		input: ClaudeLLMInput;
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
		model?: string;
	}): Promise<ReadableStream> {
		const { sessionId, input, onComplete, signal, model } = params;
		const requestBody = {
			max_tokens: 1024,
			model: model || this.model,
			messages: input.messages,
			system: input.system,
			stream: true,
		};

		const response = await fetch(`${this.endpoint}/messages`, {
			method: 'POST',
			headers: this.getBaseHeaders(),
			body: JSON.stringify(requestBody),
			signal
		});

		console.log('response from claude');

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			throw new Error(errorText || `LLM API error: ${response.status} ${response.statusText}`);
		}

		return handleSSEStream({
			response,
			sessionId,
			onComplete,
			signal,
			parser: (parsed) => ({
				delta: (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') ? parsed.delta.text : undefined,
				isDone: parsed.type === 'message_stop'
			})
		});
	}
}
