import { env } from 'cloudflare:workers';
import { LLMContentItem, LLMInput, LLMOutputContentItem, LLMResponse, MessageEntry } from './types';
import { regenerateSignedUrl } from './assets.utils';

export class LLMService {
	constructor(private endpoint: string, private apiKey: string, private model: string) {}

	async generateResponse(input: LLMInput[], signal?: AbortSignal): Promise<LLMOutputContentItem[]> {
		const response = await fetch(`${this.endpoint}/responses`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			signal,
			body: JSON.stringify({
				model: this.model,
				input,
			}),
		});

		if (!response.ok) {
			throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
		}

		const data: LLMResponse = await response.json();
		console.log('LLM Response:', data);

		// Get all outputs with message type, extract their content arrays, and flatten
		return data.output?.filter((item) => item.type === 'message')?.flatMap((messageOutput) => messageOutput.content || []) || [];
	}

	// NEW: Streaming method
	async generateStreamingResponse(
		input: LLMInput[],
		onComplete?: (completeStreamText: string) => Promise<void> | void,
		signal?: AbortSignal
	): Promise<ReadableStream> {
		const requestBody = {
			model: this.model,
			input,
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
			// Get the error response body
			const errorText = await response.text();
			throw new Error(`LLM API error: ${response.status} ${response.statusText} - ${errorText}`);
		}

		if (!response.body) {
			throw new Error('Response body is null');
		}

		// Create a transform stream to parse SSE and extract text
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		// If an external AbortSignal aborts, close/abort our writer and cancel the reader.
		const onAbort = () => {
			reader.cancel().catch(() => {});
			writer.abort(new Error('Aborted'));
		};

		// Attach abort handler if provided
		if (signal) {
			if (signal.aborted) {
				onAbort();
				// return an empty readable to avoid hanging
				writer.close().catch(() => {});
				return readable;
			}
			signal.addEventListener('abort', onAbort);
		}

		// Process stream in background
		(async () => {
			try {
				let buffer = '';
				let fullResponse = ''; // Track complete response for logging
				let currentChunk = ''; // Accumulate deltas

				while (true) {
					const { done, value } = await reader.read();

					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const data = line.slice(6);

							if (data === '[DONE]') continue;

							try {
								const parsed = JSON.parse(data);

								// Accumulate deltas
								if (parsed.type === 'response.output_text.delta' && parsed.delta) {
									currentChunk += parsed.delta;
									// Stream each delta immediately to client
									await writer.write(new TextEncoder().encode(parsed.delta));
									fullResponse += parsed.delta;
								}

								// When done, log the complete chunk
								if (parsed.type === 'response.output_text.done') {
									console.log('Complete chunk:', currentChunk);
									await onComplete?.(currentChunk);
									currentChunk = ''; // Reset for next message
								}
							} catch (e) {
								console.error('Error parsing SSE data:', {
									error: e instanceof Error ? e.message : String(e),
									line,
									data,
									timestamp: new Date().toISOString(),
								});
								// Don't abort - continue processing other chunks
							}
						}
					}
				}
				// Log the complete response when done
				console.log('Complete streamed response:', fullResponse);
				console.log('Total characters streamed:', fullResponse.length);

				await writer.close();
			} catch (error) {
				await writer.abort(error);
			}
		})();

		return readable;
	}

	// Helper method to convert MessageEntry to LLMInput
	static _messageEntryToLLMInput(entry: MessageEntry): LLMInput {
		return {
			role: 'user',
			content: [
				...(entry.prompt ? [{ type: 'input_text' as const, text: entry.prompt }] : []),
				...(entry.remoteImage ? [{ type: 'input_image' as const, image_url: entry.remoteImage.url }] : []),
			],
		};
	}

	// Convenience method for single message
	async generateAssistantResponse(userMessage: MessageEntry): Promise<any> {
		const message = LLMService._messageEntryToLLMInput(userMessage);
		return this.generateResponse([message]);
	}

	// Process initial style analysis session messages for LLM input
	async prepareMessagesForLLM(messages: MessageEntry[]): Promise<LLMInput[]> {
		const processedMessages: LLMInput[] = [];
		let systemPrompts: string[] = [];

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];

			if (message.role === 'user') {
				// Check if this user message follows system prompts
				// Modify user messages following system prompts to be developer role
				if (systemPrompts.length > 0 && i > 0) {
					// This is a user response to system prompts - create developer message
					const lastSystemPrompt = systemPrompts[systemPrompts.length - 1];
					const developerMessage = `Here is the response to "${lastSystemPrompt}": ${message.prompt}. Use that information and talk like a personal stylist.`;

					processedMessages.push({
						role: 'developer',
						content: developerMessage,
					});

					systemPrompts = []; // Clear system prompts after processing
				} else {
					// Regular user message with content array
					const content: Array<LLMContentItem> = [];

					if (message.prompt) {
						content.push({ type: 'input_text', text: message.prompt });
					}

					if (message.remoteImage) {
						const freshSignedUrl = await regenerateSignedUrl(message.remoteImage.url);
						content.push({
							type: 'input_image',
							image_url: freshSignedUrl,
						});
					}
					processedMessages.push({
						role: 'user',
						content,
					});
				}
			} else if (message.role === 'system') {
				// Collect system prompts for later processing
				if (message.prompt) {
					systemPrompts.push(message.prompt);
				}
			} else if (message.role === 'assistant') {
				// Include assistant responses for context
				if (message.prompt) {
					processedMessages.push({
						role: 'assistant', // or map to appropriate role
						content: message.prompt,
					});
				}
			}
		}

		return processedMessages;
	}
}

export const createLLMService = (): LLMService => {
	return new LLMService(env.MODEL_ENDPOINT_URL, env.MODEL_API_KEY, env.OPENAI_MODEL_VERSION);
};
