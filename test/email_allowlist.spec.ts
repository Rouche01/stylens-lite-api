import { describe, it, expect } from 'vitest';
import {
	filterByAllowlist,
	parseEmailAllowlist,
	shouldRestrictToAllowlist,
} from '../src/jobs/email_allowlist';

describe('email allowlist helpers', () => {
	it('parses comma-separated emails', () => {
		const set = parseEmailAllowlist(' a@x.com, B@Y.com ,, ');
		expect(set.has('a@x.com')).toBe(true);
		expect(set.has('b@y.com')).toBe(true);
		expect(set.size).toBe(2);
	});

	it('restricts only outside staging/production', () => {
		expect(shouldRestrictToAllowlist('dev')).toBe(true);
		expect(shouldRestrictToAllowlist('staging')).toBe(false);
		expect(shouldRestrictToAllowlist('production')).toBe(false);
	});

	it('filters candidates when allowlist set', () => {
		const rows = [
			{ email: 'a@x.com' },
			{ email: 'b@x.com' },
		];
		const allow = parseEmailAllowlist('a@x.com');
		expect(filterByAllowlist(rows, allow, true)).toEqual([{ email: 'a@x.com' }]);
		expect(filterByAllowlist(rows, new Set(), true)).toEqual([]);
		expect(filterByAllowlist(rows, new Set(), false)).toEqual(rows);
	});
});
