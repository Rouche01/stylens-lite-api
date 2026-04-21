import { LLMProviderInput, LLMProviderOutputContent, MessageEntry, OpenAIContentBlock, OpenAILLMInput, OpenAILLMResponse, OpenAIMessage } from '../../../utils/types';
import { regenerateSignedUrl } from '../../../utils/assets.utils';
import { ILLMProvider } from './base.provider';
import { handleSSEStream } from '../../../utils/llm_stream.utils';

export class OpenAIProvider implements ILLMProvider {
	constructor(
		private endpoint: string,
		private apiKey: string,
		private model: string
	) { }

	async prepareMessagesForLLM(messages: MessageEntry[]): Promise<OpenAILLMInput> {
		const processedMessages: OpenAIMessage[] = [];

		for (const message of messages) {
			if (message.role === 'user') {
				const content: Array<OpenAIContentBlock> = [];

				if (message.prompt) {
					content.push({ type: 'input_text', text: message.prompt });
				}

				// Handle single image (legacy)
				if (message.remoteImage) {
					const freshSignedUrl = await regenerateSignedUrl(message.remoteImage.url);
					content.push({
						type: 'input_image',
						image_url: freshSignedUrl,
					});
				}

				// Handle multiple images
				if (message.remoteImages && message.remoteImages.length > 0) {
					for (const img of message.remoteImages) {
						// Avoid duplication if the same image is in both
						if (!message.remoteImage || message.remoteImage.url !== img.url) {
							const freshSignedUrl = await regenerateSignedUrl(img.url);
							content.push({
								type: 'input_image',
								image_url: freshSignedUrl,
							});
						}
					}
				}

				processedMessages.push({
					role: 'user',
					content,
				});
			} else if (message.role === 'system') {
				// Direct mapping of system messages to developer role for clear context setting
				if (message.prompt) {
					processedMessages.push({
						role: 'developer',
						content: message.prompt,
					});
				}
			} else if (message.role === 'assistant') {
				// Include assistant responses for context
				if (message.prompt) {
					processedMessages.push({
						role: 'assistant',
						content: message.prompt,
					});
				}
			}
		}

		return { messages: processedMessages };
	}

	async generateResponse(params: {
		input: LLMProviderInput;
		format?: { type: 'json_schema' | 'text' | 'json_object'; name?: string; schema?: object };
		signal?: AbortSignal;
		model?: string;
	}): Promise<LLMProviderOutputContent[]> {
		const { input, format, signal, model } = params;
		const response = await fetch(`${this.endpoint}/responses`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			signal,
			body: JSON.stringify({
				model: model || this.model,
				input: input.messages,
				...(format ? { text: { format } } : {}),
			}),
		});

		if (!response.ok) {
			const errorData = await response.json().catch(() => ({}));
			const errorMessage = (errorData as any)?.error?.message ?? `LLM API error: ${response.status} ${response.statusText}`;
			throw new Error(errorMessage);
		}

		const data: OpenAILLMResponse = await response.json();

		// Get all outputs with message type, extract their content arrays, and flatten
		return data.output?.filter((item) => item.type === 'message')?.flatMap((messageOutput) => messageOutput.content || []) || [];
	}

	async generateStreamingResponse(params: {
		sessionId: string;
		input: LLMProviderInput;
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
		model?: string;
	}): Promise<ReadableStream> {
		const { sessionId, input, onComplete, signal, model } = params;
		const requestBody = {
			model: model || this.model,
			input: input.messages,
			stream: true,
		};

		const response = await fetch(`${this.endpoint}/responses`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(requestBody),
			signal,
		});

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
				delta: (parsed.type === 'response.output_text.delta' && parsed.delta) ? parsed.delta : undefined,
				isDone: parsed.type === 'response.output_text.done'
			})
		});
	}
}
