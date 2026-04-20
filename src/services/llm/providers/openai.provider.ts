import { LLMContentItem, LLMOutputContentItem, LLMProviderInput, LLMResponse, MessageEntry, OpenAILLMInput, OpenAIMessage } from '../../../utils/types';
import { regenerateSignedUrl } from '../../../utils/assets.utils';
import { ILLMProvider } from './base.provider';

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
				// Regular user message with content array
				const content: Array<LLMContentItem> = [];

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
	}): Promise<LLMOutputContentItem[]> {
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

		const data: LLMResponse = await response.json();

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

		if (!response.body) {
			throw new Error('Response body is null');
		}

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		const onAbort = () => {
			reader.cancel().catch(() => { });
			writer.abort(new Error('Aborted'));
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
				writer.close().catch(() => { });
				return readable;
			}
			signal.addEventListener('abort', onAbort);
		}

		(async () => {
			try {
				let buffer = '';
				let currentChunk = '';

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const dataStr = line.slice(6);
							if (dataStr === '[DONE]') continue;

							try {
								const parsed = JSON.parse(dataStr);

								if (parsed.type === 'response.output_text.delta' && parsed.delta) {
									const sessionPrefix = `|||sessionId_${sessionId}|||`;
									currentChunk += parsed.delta;
									const streamedDelta = sessionPrefix + parsed.delta;
									await writer.write(new TextEncoder().encode(streamedDelta));
								}

								if (parsed.type === 'response.output_text.done') {
									await onComplete?.(currentChunk);
									currentChunk = '';
								}
							} catch (e) {
								console.error('Error parsing SSE data:', e);
							}
						}
					}
				}
				await writer.close();
			} catch (error) {
				await writer.abort(error);
			}
		})();

		return readable;
	}
}
