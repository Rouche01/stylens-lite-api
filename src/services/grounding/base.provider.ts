import { OutfitBoundingBox } from 'types';

export type GroundingInput = {
	imageUrl: string;
	prompt: string;
	imageWidth: number;
	imageHeight: number;
	signal?: AbortSignal;
};

export type GroundingResult = {
	box: OutfitBoundingBox;
	promptUsed: string;
	score?: number;
	provider: string;
};

export class GroundingError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'GroundingError';
	}
}

export interface GroundingProvider {
	readonly name: string;
	groundPhrase(input: GroundingInput): Promise<GroundingResult | null>;
}
