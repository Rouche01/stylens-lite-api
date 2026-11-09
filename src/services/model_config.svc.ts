import { env } from 'cloudflare:workers';

export enum ModelProvider {
	OPENAI = 'OPENAI',
	CLAUDE = 'CLAUDE',
}

export enum ModelUseCase {
	STYLE_ANALYSIS = 'STYLE_ANALYSIS',
	CLASSIFICATION = 'CLASSIFICATION',
	TITLE_GENERATION = 'TITLE_GENERATION',
	OUTFIT_EXTRACTION = 'OUTFIT_EXTRACTION',
	AVATAR_FRAMING = 'AVATAR_FRAMING',
}

const FAST_TASK_USE_CASES: ReadonlySet<ModelUseCase> = new Set([
	ModelUseCase.CLASSIFICATION,
	ModelUseCase.TITLE_GENERATION,
	ModelUseCase.AVATAR_FRAMING,
]);

export function isFastTaskUseCase(useCase: ModelUseCase): boolean {
	return FAST_TASK_USE_CASES.has(useCase);
}

export interface LLMConfig {
	endpoint: string;
	apiKey: string;
	model: string;
	provider: ModelProvider;
	bucket?: R2Bucket;
}

export class ModelConfigService {
	constructor(private provider: ModelProvider = ModelProvider.OPENAI) { }

	getConfig(useCase: ModelUseCase): LLMConfig {

		const modelVersion = this._getModelVersionForUseCase(useCase);

		const { provider, config: providerConfig } = this._getProviderConfig();

		// Use specific flash/mini model for fast tasks
		if (isFastTaskUseCase(useCase)) {
			return {
				...providerConfig,
				model: modelVersion,
				provider: provider,
				bucket: env.OUTFIT_PHOTOS_BUCKET
			};
		}

		if (useCase === ModelUseCase.OUTFIT_EXTRACTION) {
			return {
				...providerConfig,
				model: modelVersion,
				provider: provider,
				bucket: env.OUTFIT_PHOTOS_BUCKET
			};
		}

		if (useCase === ModelUseCase.STYLE_ANALYSIS) {
			return {
				...providerConfig,
				model: modelVersion,
				provider: provider,
				bucket: env.OUTFIT_PHOTOS_BUCKET
			};
		}

		return {
			...providerConfig,
			model: modelVersion,
			provider: provider,
			bucket: env.OUTFIT_PHOTOS_BUCKET
		};
	}


	private _getProviderConfig(): { provider: ModelProvider, config: Pick<LLMConfig, 'endpoint' | 'apiKey'> } {
		switch (this.provider) {
			case ModelProvider.OPENAI:
				return { provider: ModelProvider.OPENAI, config: { endpoint: env.OPENAI_MODEL_ENDPOINT_URL, apiKey: env.OPENAI_MODEL_API_KEY } };
			case ModelProvider.CLAUDE:
				return { provider: ModelProvider.CLAUDE, config: { endpoint: env.CLAUDE_ENDPOINT_URL, apiKey: env.CLAUDE_API_KEY } };
			default:
				throw new Error(`Unsupported model provider: ${this.provider}`);
		}
	}

	private _getModelVersionForUseCase(useCase: ModelUseCase): string {
		if (this.provider === ModelProvider.OPENAI) {
			if (isFastTaskUseCase(useCase)) {
				return env.OPENAI_FAST_TASK_MODEL_VERSION;
			}
			switch (useCase) {
				case ModelUseCase.OUTFIT_EXTRACTION:
					return env.OPENAI_OUTFIT_EXTRACTION_MODEL_VERSION;
				case ModelUseCase.STYLE_ANALYSIS:
					return env.OPENAI_STYLE_ANALYSIS_MODEL_VERSION;
				default:
					throw new Error(`Unsupported model use case: ${useCase}`);
			}
		}

		if (this.provider === ModelProvider.CLAUDE) {
			if (isFastTaskUseCase(useCase)) {
				return env.CLAUDE_FAST_TASK_MODEL_VERSION;
			}
			switch (useCase) {
				case ModelUseCase.OUTFIT_EXTRACTION:
					return env.CLAUDE_OUTFIT_EXTRACTION_MODEL_VERSION;
				case ModelUseCase.STYLE_ANALYSIS:
					return env.CLAUDE_STYLE_ANALYSIS_MODEL_VERSION;
				default:
					throw new Error(`Unsupported model use case: ${useCase}`);
			}
		}

		throw new Error(`Unsupported model provider: ${this.provider}`);
	}
}
