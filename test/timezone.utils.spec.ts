import { describe, expect, it } from 'vitest';
import {
	DEFAULT_USER_TIMEZONE,
	isValidIanaTimeZone,
	parseOptionalTimeZone,
	resolveUserTimeZone,
} from '../src/utils/timezone.utils';

describe('timezone.utils', () => {
	it('accepts common IANA zones', () => {
		expect(isValidIanaTimeZone('Europe/Amsterdam')).toBe(true);
		expect(isValidIanaTimeZone('America/New_York')).toBe(true);
		expect(isValidIanaTimeZone('UTC')).toBe(true);
		expect(isValidIanaTimeZone('  Asia/Tokyo  ')).toBe(true);
	});

	it('rejects invalid zones', () => {
		expect(isValidIanaTimeZone('')).toBe(false);
		expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
		expect(isValidIanaTimeZone('GMT+2')).toBe(false);
	});

	it('parseOptionalTimeZone treats blank as null and throws on bad ids', () => {
		expect(parseOptionalTimeZone(undefined)).toBeNull();
		expect(parseOptionalTimeZone(null)).toBeNull();
		expect(parseOptionalTimeZone('')).toBeNull();
		expect(parseOptionalTimeZone('   ')).toBeNull();
		expect(parseOptionalTimeZone('Europe/Amsterdam')).toBe('Europe/Amsterdam');
		expect(() => parseOptionalTimeZone('Nope')).toThrow(/IANA/);
		expect(() => parseOptionalTimeZone(12)).toThrow(/string/);
	});

	it('resolveUserTimeZone falls back to UTC', () => {
		expect(resolveUserTimeZone(null)).toBe(DEFAULT_USER_TIMEZONE);
		expect(resolveUserTimeZone(undefined)).toBe(DEFAULT_USER_TIMEZONE);
		expect(resolveUserTimeZone('')).toBe(DEFAULT_USER_TIMEZONE);
		expect(resolveUserTimeZone('Europe/Paris')).toBe('Europe/Paris');
	});
});
