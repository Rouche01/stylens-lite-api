import { Logger, createLogger } from '../../utils/logger.utils';
import {
	CropEncoder,
	createCropEncoder,
	type EmbedClosetCropParams,
	type EmbedClosetCropResult,
	type PreparedClosetCrop,
	type QueryClosetCropParams,
	type QueryClosetCropResult,
	type UpsertClosetCropParams,
	type UpsertClosetCropResult,
} from './encode/cropEncoder';
import {
	OutfitIdentityProcessor,
	createOutfitIdentityWriter,
	type ProcessOutfitImageParams,
	type ProcessOutfitImageResult,
	type ResolveClosetMatchParams,
	type ResolveClosetMatchResult,
} from './write/processOutfit';

export class OutfitIdentityService {
	private writer: OutfitIdentityProcessor | undefined;

	constructor(
		private encode: CropEncoder,
		private envBindings: Env,
		private log: Logger
	) {}

	async embedClosetCrop(params: EmbedClosetCropParams): Promise<EmbedClosetCropResult> {
		return this.encode.embedClosetCrop(params);
	}

	async upsertClosetCrop(params: UpsertClosetCropParams): Promise<UpsertClosetCropResult> {
		return this.encode.upsertClosetCrop(params);
	}

	async queryClosetCrop(params: QueryClosetCropParams): Promise<QueryClosetCropResult> {
		return this.encode.queryClosetCrop(params);
	}

	async prepareClosetCrop(params: EmbedClosetCropParams): Promise<PreparedClosetCrop> {
		return this.encode.prepareClosetCrop(params);
	}

	async upsertPreparedCrop(
		embedded: PreparedClosetCrop,
		params: { id?: string; userId: string; category: string; closetItemId?: string; log?: Logger }
	): Promise<UpsertClosetCropResult> {
		return this.encode.upsertPreparedCrop(embedded, params);
	}

	async getVectorsByIds(ids: string[]): Promise<Array<{ id: string }>> {
		return this.encode.getVectorsByIds(ids);
	}

	async process(params: ProcessOutfitImageParams): Promise<ProcessOutfitImageResult | null> {
		return this.writerFor().process(params);
	}

	async resolveMatch(params: ResolveClosetMatchParams): Promise<ResolveClosetMatchResult> {
		return this.writerFor().resolveMatch(params);
	}

	private writerFor(): OutfitIdentityProcessor {
		this.writer ??= createOutfitIdentityWriter(this.envBindings, this.log, this.encode);
		return this.writer;
	}
}

export const createOutfitIdentityService = (envBindings: Env, log?: Logger) => {
	const logger = (log ?? createLogger({ env: envBindings.ENV_NAME })).child({
		service: 'outfit_identity',
	});
	return new OutfitIdentityService(createCropEncoder(envBindings, logger), envBindings, logger);
};
