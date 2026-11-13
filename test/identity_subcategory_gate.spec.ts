import { describe, expect, it } from 'vitest';
import { identitySubcategoryRelation } from '../src/services/identity/decide/policy';

describe('identitySubcategoryRelation', () => {
	it('rejects upper outer vs inner (jacket ≠ shirt)', () => {
		expect(identitySubcategoryRelation('jacket', 'shirt', 'upper')).toBe('reject');
		expect(identitySubcategoryRelation('shirt', 'jacket', 'upper')).toBe('reject');
		expect(identitySubcategoryRelation('bomber', 'sweatshirt', 'upper')).toBe('reject');
		expect(identitySubcategoryRelation('hoodie', 'coat', 'upper')).toBe('reject');
	});

	it('keeps same-layer upper pairs open (Claude layer swaps)', () => {
		expect(identitySubcategoryRelation('jacket', 'cardigan', 'upper')).toBe('open');
		expect(identitySubcategoryRelation('tee', 'sweater', 'upper')).toBe('open');
		expect(identitySubcategoryRelation('jacket', 'jacket', 'upper')).toBe('exact');
	});

	it('soft-matches closed footwear; hard-blocks open vs closed', () => {
		expect(identitySubcategoryRelation('boots', 'sneakers', 'footwear')).toBe('family');
		expect(identitySubcategoryRelation('boots', 'sandals', 'footwear')).toBe('reject');
		expect(identitySubcategoryRelation('hat', 'socks', 'accessory')).toBe('reject');
	});

	it('leaves lower open', () => {
		expect(identitySubcategoryRelation('jeans', 'pants', 'lower')).toBe('open');
	});
});
