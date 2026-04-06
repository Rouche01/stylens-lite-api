import { env } from 'cloudflare:workers';
import { LLMContentItem, LLMInput, LLMOutputContentItem, LLMResponse, MessageEntry } from '../utils/types';
import { regenerateSignedUrl } from '../utils/assets.utils';
import { waitForImages } from '../utils/r2.utils';

export class LLMService {
	constructor(
		private endpoint: string,
		private apiKey: string,
		private model: string,
		private bucket?: R2Bucket
	) { }

	async generateResponse(
		input: LLMInput[],
		signal?: AbortSignal,
		format?: { type: 'json_schema' | 'text' | 'json_object'; name: string; schema: object },
	): Promise<LLMOutputContentItem[]> {
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
				...(format ? { text: { format } } : {}),
			}),
		});

		if (!response.ok) {
			const errorData = await response.json();
			const errorMessage = (errorData as any)?.error?.message ?? `LLM API error: ${response.status} ${response.statusText}`;
			throw new Error(errorMessage);
		}

		const data: LLMResponse = await response.json();

		// Get all outputs with message type, extract their content arrays, and flatten
		return data.output?.filter((item) => item.type === 'message')?.flatMap((messageOutput) => messageOutput.content || []) || [];
	}

	// NEW: Streaming method
	async generateStreamingResponse(
		sessionId: string,
		input: LLMInput[],
		onComplete?: (completeStreamText: string) => Promise<void> | void,
		signal?: AbortSignal,
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
			throw new Error(errorText ?? `LLM API error: ${response.status} ${response.statusText}`);
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
			reader.cancel().catch(() => { });
			writer.abort(new Error('Aborted'));
		};

		// Attach abort handler if provided
		if (signal) {
			if (signal.aborted) {
				onAbort();
				// return an empty readable to avoid hanging
				writer.close().catch(() => { });
				return readable;
			}
			signal.addEventListener('abort', onAbort);
		}

		// Process stream in background
		(async () => {
			try {
				let buffer = '';
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
									const sessionPrefix = `|||sessionId_${sessionId}|||`;
									currentChunk += parsed.delta;
									// Stream each delta immediately to client
									const streamedDelta = sessionPrefix + parsed.delta;
									await writer.write(new TextEncoder().encode(streamedDelta));
								}

								// When done, notify completion
								if (parsed.type === 'response.output_text.done') {
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

				await writer.close();
			} catch (error) {
				await writer.abort(error);
			}
		})();

		return readable;
	}

	static _messageEntryToLLMInput(entry: MessageEntry): LLMInput {
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
		const message = LLMService._messageEntryToLLMInput(userMessage);
		return this.generateResponse([message]);
	}

	// Process initial style analysis session messages for LLM input
	async prepareMessagesForLLM(messages: MessageEntry[]): Promise<LLMInput[]> {
		// 1. Collect all unique image keys for polling
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

type LLMServiceOpts = Partial<{
	endpoint: string;
	apiKey: string;
	model: string;
	bucket: R2Bucket;
}>;

export const createLLMService = (opts?: LLMServiceOpts): LLMService => {
	return new LLMService(
		opts?.endpoint ?? env.MODEL_ENDPOINT_URL,
		opts?.apiKey ?? env.MODEL_API_KEY,
		opts?.model ?? env.OPENAI_MODEL_VERSION,
		opts?.bucket ?? env.OUTFIT_PHOTOS_BUCKET
	);
};
