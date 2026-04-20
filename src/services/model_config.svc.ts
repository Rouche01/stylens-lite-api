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
}

export interface LLMConfig {
	endpoint: string;
	apiKey: string;
	model: string;
	bucket?: R2Bucket;
}

export class ModelConfigService {
	constructor(private provider: ModelProvider = ModelProvider.OPENAI) { }

	getConfig(useCase: ModelUseCase): LLMConfig {

		const modelVersion = this._getModelVersionForUseCase(useCase);

		// Use specific flash/mini model for fast tasks
		if (useCase === ModelUseCase.CLASSIFICATION || useCase === ModelUseCase.TITLE_GENERATION) {
			return {
				...this._getProviderConfig().config,
				model: modelVersion,
				bucket: env.OUTFIT_PHOTOS_BUCKET
			};
		}

		if (useCase === ModelUseCase.OUTFIT_EXTRACTION) {
			return {
				...this._getProviderConfig().config,
				model: modelVersion,
				bucket: env.OUTFIT_PHOTOS_BUCKET
			};
		}

		if (useCase === ModelUseCase.STYLE_ANALYSIS) {
			return {
				...this._getProviderConfig().config,
				model: modelVersion,
				bucket: env.OUTFIT_PHOTOS_BUCKET
			};
		}

		return {
			...this._getProviderConfig().config,
			model: modelVersion,
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
			switch (useCase) {
				case ModelUseCase.CLASSIFICATION:
				case ModelUseCase.TITLE_GENERATION:
					return env.OPENAI_FAST_TASK_MODEL_VERSION;
				case ModelUseCase.OUTFIT_EXTRACTION:
					return env.OPENAI_OUTFIT_EXTRACTION_MODEL_VERSION;
				case ModelUseCase.STYLE_ANALYSIS:
					return env.OPENAI_STYLE_ANALYSIS_MODEL_VERSION;
				default:
					throw new Error(`Unsupported model use case: ${useCase}`);
			}
		}

		if (this.provider === ModelProvider.CLAUDE) {
			switch (useCase) {
				case ModelUseCase.CLASSIFICATION:
					return env.CLAUDE_FAST_TASK_MODEL_VERSION;
				case ModelUseCase.TITLE_GENERATION:
					return env.CLAUDE_FAST_TASK_MODEL_VERSION;
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
