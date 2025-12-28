export type RemoteImage = {
	url: string;
	key: string;
};

export type MessageEntry = {
	remoteImage?: RemoteImage;
	prompt?: string;
	role: 'user' | 'assistant' | 'system';
};

export type LLMMessageRole = 'user' | 'developer' | 'assistant';

export type LLMContentItem = {
	type: 'input_text' | 'input_image';
	text?: string;
	image_url?: string;
};

export type LLMInput = {
	role: LLMMessageRole;
	content: LLMContentItem[] | string;
};

export type LLMOutputContentItem = {
	type: 'output_text';
	text: string;
	annotations: any[];
};

export type LLMOutputMessage = {
	id: string;
	type: 'message';
	status: 'completed' | 'failed' | 'incomplete';
	content: LLMOutputContentItem[];
	role: 'assistant';
};

export type LLMResponse = {
	id: string;
	object: 'response';
	created_at: number;
	status: 'completed' | 'failed' | 'incomplete';
	background: boolean;
	billing: {
		payer: string;
	};
	error: any;
	incomplete_details: any;
	instructions: any;
	max_output_tokens: number | null;
	max_tool_calls: number | null;
	model: string;
	output: LLMOutputMessage[];
	parallel_tool_calls: boolean;
	previous_response_id: string | null;
	prompt_cache_key: string | null;
	reasoning: {
		effort: any;
		summary: any;
	};
	safety_identifier: string | null;
	service_tier: string;
	store: boolean;
	temperature: number;
	text: {
		format: { type: string };
		verbosity: string;
	};
	tool_choice: string;
	tools: any[];
	top_logprobs: number;
	top_p: number;
	truncation: string;
	usage: {
		input_tokens: number;
		input_tokens_details: { cached_tokens: number };
		output_tokens: number;
		output_tokens_details: { reasoning_tokens: number };
		total_tokens: number;
	};
	user: any;
	metadata: Record<string, any>;
};
