import { LLMInput, LLMOutputContentItem } from '../../../utils/types';

export interface ILLMProvider {
	generateResponse(params: {
		input: LLMInput[];
		format?: { type: 'json_schema' | 'text' | 'json_object'; name?: string; schema?: object };
		signal?: AbortSignal;
		model?: string;
	}): Promise<LLMOutputContentItem[]>;

	generateStreamingResponse(params: {
		sessionId: string;
		input: LLMInput[];
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
		model?: string;
	}): Promise<ReadableStream>;
}
