import { LLMInput, LLMOutputContentItem } from '../../../utils/types';
import { ILLMProvider } from './base.provider';

export class ClaudeProvider implements ILLMProvider {
	constructor(
		private endpoint: string,
		private apiKey: string,
		private model: string
	) { }

	async generateResponse(params: {
		input: LLMInput[];
		format?: { type: 'json_schema' | 'text' | 'json_object'; name?: string; schema?: object };
		signal?: AbortSignal;
		model?: string;
	}): Promise<LLMOutputContentItem[]> {
		// Placeholder for Claude implementation
		// This would involve translating LLMInput to Claude's message structure
		// and handling the Anthropic API response.
		console.log('ClaudeProvider.generateResponse called with model:', params.model || this.model);
		throw new Error('ClaudeProvider not fully implemented yet');
	}

	async generateStreamingResponse(params: {
		sessionId: string;
		input: LLMInput[];
		onComplete?: (completeStreamText: string) => Promise<void> | void;
		signal?: AbortSignal;
		model?: string;
	}): Promise<ReadableStream> {
		// Placeholder for Claude streaming implementation
		console.log('ClaudeProvider.generateStreamingResponse called with model:', params.model || this.model);
		throw new Error('ClaudeProvider streaming not fully implemented yet');
	}
}
