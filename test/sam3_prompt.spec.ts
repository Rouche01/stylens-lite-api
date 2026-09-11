import { describe, it, expect } from 'vitest';
import { sam3PromptCandidates } from '../src/services/segmentation/sam3_prompt';

describe('sam3PromptCandidates', () => {
	it('maps overshirt jargon to jacket noun phrases', () => {
		expect(sam3PromptCandidates('olive green overshirt')).toEqual([
			'olive green jacket',
			'olive jacket',
			'jacket',
		]);
	});

	it('keeps an already-valid SAM 3 noun phrase first', () => {
		expect(sam3PromptCandidates('black leather bomber jacket')[0]).toBe(
			'black leather bomber jacket'
		);
	});

	it('maps cap to hat', () => {
		expect(sam3PromptCandidates('black baseball cap')).toContain('hat');
	});

	it('maps base layer jargon to t-shirt and keeps the first color', () => {
		expect(sam3PromptCandidates('gray and black base')).toEqual([
			'gray black t-shirt',
			'gray t-shirt',
			't-shirt',
		]);
	});
});
