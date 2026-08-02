import { describe, it, expect } from 'vitest';
import {
	STYLIST_OPENER_MAX_TEXT_LENGTH,
	validateStylistOpenersBody,
} from '../src/routes/config/utils/validateStylistOpeners';

const validBody = {
	messages: [
		{
			id: 'with-1',
			text: 'Looking great! What\'s the occasion?',
			tags: ['with_image'],
		},
		{
			id: 'without-1',
			text: 'Hey! I\'m your stylist.',
			tags: ['without_image'],
		},
	],
};

describe('validateStylistOpenersBody', () => {
	it('accepts a valid pool and preserves ids', () => {
		const result = validateStylistOpenersBody(validBody);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0].id).toBe('with-1');
		expect(result.messages[0].tags).toEqual(['with_image']);
	});

	it('rejects empty messages', () => {
		const result = validateStylistOpenersBody({ messages: [] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/empty/i);
	});

	it('rejects missing with_image tag coverage', () => {
		const result = validateStylistOpenersBody({
			messages: [
				{ text: 'Only without', tags: ['without_image'] },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/with_image/);
	});

	it('rejects missing without_image tag coverage', () => {
		const result = validateStylistOpenersBody({
			messages: [
				{ text: 'Only with', tags: ['with_image'] },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/without_image/);
	});

	it('rejects duplicate texts', () => {
		const result = validateStylistOpenersBody({
			messages: [
				{ text: 'Same line', tags: ['with_image'] },
				{ text: '  Same line  ', tags: ['without_image'] },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/Duplicate/);
	});

	it('rejects oversized text', () => {
		const result = validateStylistOpenersBody({
			messages: [
				{
					text: 'x'.repeat(STYLIST_OPENER_MAX_TEXT_LENGTH + 1),
					tags: ['with_image'],
				},
				{ text: 'Without image opener', tags: ['without_image'] },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/at most/);
	});

	it('rejects invalid tags', () => {
		const result = validateStylistOpenersBody({
			messages: [
				{ text: 'Bad tag', tags: ['morning'] },
				{ text: 'Without', tags: ['without_image'] },
			],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/invalid tag/);
	});

	it('generates ids when omitted', () => {
		const result = validateStylistOpenersBody({
			messages: [
				{ text: 'With image opener', tags: ['with_image'] },
				{ text: 'Without image opener', tags: ['without_image'] },
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.messages[0].id).toBeTruthy();
		expect(result.messages[1].id).toBeTruthy();
		expect(result.messages[0].id).not.toBe(result.messages[1].id);
	});
});
