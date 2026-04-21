export type RemoteImage = {
	url: string;
	key: string;
};

export type MessageEntry = {
	remoteImage?: RemoteImage; // Deprecated: use remoteImages
	remoteImages?: RemoteImage[];
	prompt?: string;
	role: 'user' | 'assistant' | 'system';
};

export type LLMMessageRole = 'user' | 'developer' | 'assistant' | 'system';

export type LLMContentItem = {
	type: 'input_text' | 'input_image';
	text?: string;
	image_url?: string;
};

export type LLMInput = {
	role: LLMMessageRole;
	content: LLMContentItem[] | string;
};

// OpenAI-specific types
export type OpenAIInputRole = 'user' | 'developer' | 'assistant' | 'system';

export type OpenAIContentBlock = {
	type: 'input_text' | 'input_image';
	text?: string;
	image_url?: string;
}

export type OpenAIMessage = {
	role: OpenAIInputRole;
	content: OpenAIContentBlock[] | string;
}

export type OpenAILLMInput = {
	messages: OpenAIMessage[];
}

export type OpenAILLMOutputContentItem = {
	type: 'output_text';
	text: string;
	annotations: any[];
};

export type OpenAILLMOutputMessage = {
	id: string;
	type: 'message';
	status: 'completed' | 'failed' | 'incomplete';
	content: OpenAILLMOutputContentItem[];
	role: 'assistant';
};

export type OpenAILLMResponse = {
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
	output: OpenAILLMOutputMessage[];
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


// Claude-specific types
export type ClaudeInputRole = 'user' | 'assistant';

export type ClaudeTextBlock = {
	text: string;
	type: 'text';
}

export type ClaudeImageBlock = {
	source: {
		type: 'url',
		url: string;
	}
	type: 'image'
}

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeImageBlock;

export type ClaudeMessage = {
	content: string | ClaudeContentBlock[];
	role: ClaudeInputRole;
}

export type ClaudeSystemPrompt = string | ClaudeTextBlock[];

export type ClaudeLLMInput = {
	messages: ClaudeMessage[];
	system?: ClaudeSystemPrompt;
}

export type ClaudeUsage = {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
};

export type ClaudeLLMResponse = {
	id: string;
	type: 'message';
	role: 'assistant';
	content: ClaudeTextBlock[];
	model: string;
	stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
	stop_sequence: string | null;
	usage: ClaudeUsage;
};

export type LLMProviderInput = OpenAILLMInput | ClaudeLLMInput;
export type LLMProviderOutputContent = OpenAILLMOutputContentItem | ClaudeTextBlock

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
