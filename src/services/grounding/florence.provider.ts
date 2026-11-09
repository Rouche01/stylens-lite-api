import { GroundingError, GroundingInput, GroundingProvider, GroundingResult } from './base.provider';
import { collectGroundingBoxes, pickGroundedPercentBox } from './boxes';

const FAL_FLORENCE_ENDPOINT = 'https://fal.run/fal-ai/florence-2-large/caption-to-phrase-grounding';

export class FlorenceGroundingProvider implements GroundingProvider {
	readonly name = 'fal-florence-2';

	constructor(private apiKey: string) {}

	async groundPhrase(input: GroundingInput): Promise<GroundingResult | null> {
		const apiKey = this.apiKey?.trim();
		if (!apiKey) {
			throw new GroundingError('FAL_KEY is not set', 500);
		}

		const response = await fetch(FAL_FLORENCE_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Key ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				image_url: input.imageUrl,
				text_input: input.prompt,
			}),
			signal: input.signal,
		});

		const json: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const message =
				(json && typeof json === 'object' && 'detail' in json && JSON.stringify((json as { detail: unknown }).detail)) ||
				`Florence grounding failed (${response.status})`;
			throw new GroundingError(String(message), response.status);
		}

		const picked = pickGroundedPercentBox(
			collectGroundingBoxes(json),
			input.imageWidth,
			input.imageHeight
		);
		if (!picked) return null;

		return {
			box: picked.box,
			promptUsed: input.prompt,
			score: picked.score,
			provider: this.name,
		};
	}
}
