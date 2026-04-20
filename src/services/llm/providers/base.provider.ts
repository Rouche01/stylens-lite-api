import { LLMOutputContentItem, LLMProviderInput, MessageEntry } from '../../../utils/types';

export interface ILLMProvider {
	prepareMessagesForLLM(messages: MessageEntry[]): Promise<LLMProviderInput>;

	generateResponse(params: {
		input: LLMProviderInput;
		format?: { type: 'json_schema' | 'text' | 'json_object'; name?: string; schema?: object };
		signal?: AbortSignal;
		model?: string;
	}): Promise<LLMOutputContentItem[]>;

	generateStreamingResponse(params: {
		sessionId: string;
		input: LLMProviderInput;
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
		model?: string;
	}): Promise<ReadableStream>;
}
