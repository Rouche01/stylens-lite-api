import { describe, it, expect, vi } from 'vitest';
import { waitForImages, ImageUploadTimeoutError } from '../src/utils/r2.utils';

describe('waitForImages', () => {
	it('should resolve immediately if no keys are provided', async () => {
		const mockBucket = {} as R2Bucket;
		await expect(waitForImages(mockBucket, [])).resolves.toBeUndefined();
	});

	it('should resolve when all images are found', async () => {
		const mockBucket = {
			head: vi.fn()
				.mockResolvedValueOnce(null) // first call for 'a'
				.mockResolvedValueOnce(null) // first call for 'b'
				.mockResolvedValueOnce({ key: 'a' }) // second call for 'a'
				.mockResolvedValueOnce({ key: 'b' }) // second call for 'b'
		} as unknown as R2Bucket;

		await waitForImages(mockBucket, ['a', 'b'], { intervalMs: 1 });
		expect(mockBucket.head).toHaveBeenCalledTimes(4);
	});

	it('should throw ImageUploadTimeoutError on timeout', async () => {
		const mockBucket = {
			head: vi.fn().mockResolvedValue(null)
		} as unknown as R2Bucket;

		await expect(waitForImages(mockBucket, ['a'], { timeoutMs: 10, intervalMs: 1 }))
			.rejects.toThrow(ImageUploadTimeoutError);
	});
});
