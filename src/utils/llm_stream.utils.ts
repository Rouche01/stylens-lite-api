/**
 * Shared utility for handling Server-Sent Events (SSE) from LLM providers.
 * Manages the boilerplate of TransformStream, chunk buffering, and line splitting.
 */
export async function handleSSEStream(params: {
	response: Response;
	sessionId: string;
	onComplete?: (completeStreamText: string) => Promise<void> | void;
	signal?: AbortSignal;
	parser: (parsed: any) => { delta?: string; isDone?: boolean };
}): Promise<ReadableStream> {
	const { response, sessionId, onComplete, signal, parser } = params;

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
					// Both OpenAI and Anthropic use 'data: ' prefix for JSON payloads
					if (line.startsWith('data: ')) {
						const dataStr = line.slice(6).trim();
						if (dataStr === '[DONE]') continue;

						try {
							const parsed = JSON.parse(dataStr);
							const { delta, isDone } = parser(parsed);

							if (delta) {
								const sessionPrefix = `|||sessionId_${sessionId}|||`;
								currentChunk += delta;
								const streamedDelta = sessionPrefix + delta;
								await writer.write(new TextEncoder().encode(streamedDelta));
							}

							if (isDone) {
								await onComplete?.(currentChunk);
								currentChunk = '';
							}
						} catch (e) {
							// Silently ignore ping events or non-JSON data that might be sent by some providers
							if (dataStr !== '') {
								console.warn('Error parsing SSE data line:', dataStr, e);
							}
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
