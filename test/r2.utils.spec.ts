import { describe, it, expect, vi } from 'vitest';
import {
	getR2ObjectBytes,
	isTransientR2Error,
	r2BytesResponse,
	waitForImages,
	ImageUploadTimeoutError,
} from '../src/utils/r2.utils';

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

describe('getR2ObjectBytes', () => {
	it('retries a transient get then returns buffered bytes', async () => {
		const bytes = new Uint8Array([1, 2, 3]).buffer;
		const mockBucket = {
			get: vi.fn()
				.mockRejectedValueOnce(new Error('Network connection lost'))
				.mockResolvedValueOnce({
					key: 'photo.jpg',
					httpEtag: '"etag"',
					httpMetadata: { contentType: 'image/jpeg' },
					writeHttpMetadata(headers: Headers) {
						headers.set('content-type', 'image/jpeg');
					},
					arrayBuffer: async () => bytes.slice(0),
				}),
		} as unknown as R2Bucket;

		const result = await getR2ObjectBytes(mockBucket, 'photo.jpg', { delayMs: 1 });
		expect(result?.bytes).toEqual(bytes);
		expect(mockBucket.get).toHaveBeenCalledTimes(2);
	});

	it('returns null when the object is missing', async () => {
		const mockBucket = {
			get: vi.fn().mockResolvedValue(null),
		} as unknown as R2Bucket;
		await expect(getR2ObjectBytes(mockBucket, 'missing.jpg')).resolves.toBeNull();
		expect(mockBucket.get).toHaveBeenCalledTimes(1);
	});

	it('does not retry non-transient errors', async () => {
		const mockBucket = {
			get: vi.fn().mockRejectedValue(new Error('Access Denied')),
		} as unknown as R2Bucket;
		await expect(getR2ObjectBytes(mockBucket, 'secret.jpg', { delayMs: 1 })).rejects.toThrow(
			'Access Denied',
		);
		expect(mockBucket.get).toHaveBeenCalledTimes(1);
	});

	it('retries wrangler remote unspecified get errors', async () => {
		const bytes = new Uint8Array([4, 5, 6]).buffer;
		const mockBucket = {
			get: vi.fn()
				.mockRejectedValueOnce(new Error('get: Unspecified error (0)'))
				.mockResolvedValueOnce(fakeR2Body('photo.jpg', bytes)),
		} as unknown as R2Bucket;

		const result = await getR2ObjectBytes(mockBucket, 'photo.jpg', { delayMs: 1 });
		expect(result?.bytes).toEqual(bytes);
		expect(mockBucket.get).toHaveBeenCalledTimes(2);
	});
});

describe('isTransientR2Error', () => {
	it('matches wrangler remote / tunnel failures', () => {
		expect(isTransientR2Error(new Error('Network connection lost'))).toBe(true);
		expect(isTransientR2Error(new Error('The operation was aborted'))).toBe(true);
		expect(isTransientR2Error(new Error('get: Unspecified error (0)'))).toBe(true);
		expect(isTransientR2Error(new Error('Access Denied'))).toBe(false);
	});
});

function fakeR2Body(key: string, bytes: ArrayBuffer) {
	return {
		key,
		httpEtag: '"etag"',
		httpMetadata: { contentType: 'image/jpeg' },
		writeHttpMetadata(headers: Headers) {
			headers.set('content-type', 'image/jpeg');
		},
		arrayBuffer: async () => bytes.slice(0),
	};
}

describe('r2BytesResponse', () => {
	it('sets Content-Length from the buffered body', async () => {
		const bytes = new Uint8Array([9, 8, 7]).buffer;
		const response = r2BytesResponse(bytes, new Headers({ 'Content-Type': 'image/jpeg' }));
		expect(response.headers.get('content-length')).toBe('3');
		expect(await response.arrayBuffer()).toEqual(bytes);
	});
});
