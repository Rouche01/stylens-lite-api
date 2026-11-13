import { describe, expect, it } from 'vitest';
import { isRetryableCfImagesFailure } from '../src/utils/cf_images.utils';

describe('isRetryableCfImagesFailure', () => {
	it('retries CF Images 1031 and 5xx / 429', () => {
		expect(isRetryableCfImagesFailure(new Error('Failed to crop outfit image (1031)'))).toBe(true);
		expect(isRetryableCfImagesFailure(new Error('Failed to orient outfit image (503)'))).toBe(true);
		expect(isRetryableCfImagesFailure(new Error('Failed to resize image (429)'))).toBe(true);
	});

	it('does not retry client 4xx other than 429', () => {
		expect(isRetryableCfImagesFailure(new Error('Failed to crop outfit image (400)'))).toBe(false);
		expect(isRetryableCfImagesFailure(new Error('Failed to crop outfit image (404)'))).toBe(false);
	});

	it('retries network-style failures without a status', () => {
		expect(isRetryableCfImagesFailure(new Error('fetch failed'))).toBe(true);
		expect(isRetryableCfImagesFailure(new Error('network timeout'))).toBe(true);
	});
});
