import { describe, it, expect } from 'vitest';
import { isEnvFlagEnabled } from '../src/utils/env_flag.utils';

describe('isEnvFlagEnabled', () => {
	it('accepts true/1/yes', () => {
		expect(isEnvFlagEnabled('true')).toBe(true);
		expect(isEnvFlagEnabled('TRUE')).toBe(true);
		expect(isEnvFlagEnabled('1')).toBe(true);
		expect(isEnvFlagEnabled('yes')).toBe(true);
	});

	it('rejects false/empty/other', () => {
		expect(isEnvFlagEnabled('false')).toBe(false);
		expect(isEnvFlagEnabled('0')).toBe(false);
		expect(isEnvFlagEnabled('')).toBe(false);
		expect(isEnvFlagEnabled(undefined)).toBe(false);
	});
});
