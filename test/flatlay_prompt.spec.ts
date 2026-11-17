import { describe, expect, it } from 'vitest';
import { flatlayPromptForGarment, flatlayPromptForLabel } from '../src/services/segmentation';

describe('flatlayPromptForGarment', () => {
	it('locks appearance to the reference and treats label as type-only', () => {
		const prompt = flatlayPromptForGarment({ label: 'black baseball cap', color: 'sage green' });
		expect(prompt).toContain('black baseball cap');
		expect(prompt).toContain('reference image is the source of truth');
		expect(prompt).toContain('never recolor to match the name');
		expect(prompt).toContain('Extract color hint "sage green"');
		expect(prompt).toContain('prefer the pixels');
	});

	it('picks mint backdrop for dark colors and charcoal for light', () => {
		const dark = flatlayPromptForGarment({ label: 'navy jacket', color: 'navy' });
		expect(dark).toContain('#E8F0EE');
		expect(dark).toMatch(/solid seamless soft mint/i);
		const light = flatlayPromptForGarment({ label: 'white sneakers', color: 'white' });
		expect(light).toContain('#6B736E');
		expect(light).toMatch(/charcoal-gray/i);
	});

	it('adds footwear silhouette rules', () => {
		const prompt = flatlayPromptForGarment({
			label: 'black boots',
			color: 'black',
			category: 'footwear',
			subcategory: 'boots',
		});
		expect(prompt).toContain('footwear (boots)');
		expect(prompt).toContain('do not invent a different style');
		expect(prompt).toContain('no Chelsea boot unless the reference is one');
	});

	it('adds accessory color/logo rules for caps', () => {
		const prompt = flatlayPromptForGarment({
			label: 'black baseball cap',
			color: 'olive',
			category: 'accessory',
			subcategory: 'cap',
		});
		expect(prompt).toContain('accessory (cap)');
		expect(prompt).toContain('never repaint the item to match a color word');
		expect(prompt).toContain('logo or embroidery');
	});

	it('flatlayPromptForLabel remains a thin wrapper', () => {
		expect(flatlayPromptForLabel('cream sweater')).toBe(flatlayPromptForGarment({ label: 'cream sweater' }));
	});
});
