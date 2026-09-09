import { describe, it, expect } from 'vitest';
import { getImageMimeType } from '../src/utils/image.utils';
import { arrayBufferToBase64, fetchImageAsArrayBuffer, fetchImageAsBase64 } from '../src/utils/assets.utils';

describe('Image MIME Type Detection', () => {
	it('should detect PNG images correctly', () => {
		const buffer = new ArrayBuffer(8);
		const view = new DataView(buffer);
		view.setUint32(0, 0x89504E47);
		view.setUint32(4, 0x0D0A1A0A);

		expect(getImageMimeType(buffer)).toBe('image/png');
	});

	it('should detect JPEG images correctly', () => {
		const buffer = new ArrayBuffer(2);
		const view = new DataView(buffer);
		view.setUint16(0, 0xFFD8);

		expect(getImageMimeType(buffer)).toBe('image/jpeg');
	});

	it('should detect WebP images correctly', () => {
		const buffer = new ArrayBuffer(12);
		const view = new DataView(buffer);
		// "RIFF"
		view.setUint32(0, 0x52494646);
		// Size placeholder
		view.setUint32(4, 0x00000000);
		// "WEBP"
		view.setUint32(8, 0x57454250);

		expect(getImageMimeType(buffer)).toBe('image/webp');
	});

	it('should fall back to image/jpeg for unknown formats', () => {
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		view.setUint32(0, 0x12345678);

		expect(getImageMimeType(buffer)).toBe('image/jpeg');
	});
});

describe('High-Performance Base64 Encoder', () => {
	it('should encode standard bytes to base64 correctly', () => {
		const testStr = 'Hello World! Performance test!';
		const encoder = new TextEncoder();
		const buffer = encoder.encode(testStr).buffer;

		const base64 = arrayBufferToBase64(buffer);
		expect(base64).toBe(btoa(testStr));
	});

	it('should handle large buffers correctly without stack overflow', () => {
		// Create a 128KB buffer
		const size = 128 * 1024;
		const buffer = new ArrayBuffer(size);
		const view = new Uint8Array(buffer);
		for (let i = 0; i < size; i++) {
			view[i] = i % 256;
		}

		// Ensure no crash or call-stack issues
		const base64 = arrayBufferToBase64(buffer);
		expect(base64.length).toBeGreaterThan(0);
	});
});

describe('Data URL Decoding Support', () => {
	const testBase64 = 'SGVsbG8gd29ybGQ='; // Base64 for "Hello world"
	const dataUrl = `data:image/png;base64,${testBase64}`;

	it('should instantly parse base64 and media type from data URLs', async () => {
		const result = await fetchImageAsBase64(dataUrl);
		expect(result.mediaType).toBe('image/png');
		expect(result.base64).toBe(testBase64);
	});

	it('should instantly parse ArrayBuffer from data URLs', async () => {
		const buffer = await fetchImageAsArrayBuffer(dataUrl);
		const decoder = new TextDecoder();
		const text = decoder.decode(buffer);
		expect(text).toBe('Hello world');
	});
});
