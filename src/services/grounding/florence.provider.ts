import type { Logger } from 'utils/logger.utils';
import { FAL_MODELS, FalHttpError, falPostJson } from '../fal';
import { GroundingError, GroundingInput, GroundingProvider, GroundingResult } from './base.provider';
import { collectGroundingBoxes, pickGroundedPercentBox } from './boxes';

const FLORENCE = FAL_MODELS.grounding;

export class FlorenceGroundingProvider implements GroundingProvider {
	readonly name = 'fal-florence-2';

	constructor(
		private apiKey: string,
		private log?: Logger
	) {}

	async groundPhrase(input: GroundingInput): Promise<GroundingResult | null> {
		const apiKey = this.apiKey?.trim();
		if (!apiKey) {
			throw new GroundingError('FAL_KEY is not set', 500);
		}

		let json: unknown;
		try {
			const result = await falPostJson<unknown>({
				apiKey,
				endpoint: FLORENCE.endpoint,
				model: FLORENCE.model,
				useCase: FLORENCE.useCase,
				signal: input.signal,
				log: this.log,
				body: {
					image_url: input.imageUrl,
					text_input: input.prompt,
				},
			});
			json = result.json;
		} catch (err) {
			if (err instanceof FalHttpError) {
				throw new GroundingError(err.message, err.status);
			}
			throw err;
		}

		const picked = pickGroundedPercentBox(collectGroundingBoxes(json), input.imageWidth, input.imageHeight);
		if (!picked) return null;

		return {
			box: picked.box,
			promptUsed: input.prompt,
			score: picked.score,
			provider: this.name,
		};
	}
}
