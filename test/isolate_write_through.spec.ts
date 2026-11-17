import { describe, expect, it } from 'vitest';
import type { ApiRequest } from '../src/types';
import { serveIsolatedItem } from '../src/routes/assets/handlers/getIsolatedItemHandler';
import { isolateDerivedKey, isolateOrientedKey } from '../src/utils/isolate_cache';

const SOURCE_KEY = 'users/u1/photo.jpg';
const CROP_JPEG = fakeJpeg(80, 60);
const ORIENTED_JPEG = fakeJpeg(200, 100);

describe('isolate write-through', () => {
	it('returns a buffered derived hit and skips Images', async () => {
		const derivedKey = await tileDerivedKey({ x: '10', y: '20', w: '30', h: '40' });
		const bucket = memoryBucket();
		await bucket.put(derivedKey, CROP_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
		const images = stubImages();
		const { ctx, flush } = fakeCtx();

		const response = await serveIsolatedItem(tileRequest({ x: '10', y: '20', w: '30', h: '40' }, ctx), {
			bucket,
			images: images.binding,
			waitUntil: (p) => ctx.waitUntil(p),
		});
		await flush();

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(response.headers.get('content-length')).toBe(String(CROP_JPEG.byteLength));
		expect(await response.arrayBuffer()).toEqual(CROP_JPEG);
		expect(images.calls).toEqual([]);
		expect(bucket.puts.filter((key) => key === derivedKey)).toHaveLength(1);
	});

	it('on miss runs the pipeline, returns bytes, and waitUntil-puts the derived object', async () => {
		const bucket = memoryBucket();
		await bucket.put(SOURCE_KEY, fakeJpeg());
		const images = stubImages();
		const { ctx, flush } = fakeCtx();
		const query = { x: '10', y: '20', w: '30', h: '40' };
		const derivedKey = await tileDerivedKey(query);

		const response = await serveIsolatedItem(tileRequest(query, ctx), {
			bucket,
			images: images.binding,
			waitUntil: (p) => ctx.waitUntil(p),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(await response.arrayBuffer()).toEqual(CROP_JPEG);
		expect(ctxWaited(ctx)).toBe(true);

		await flush();

		expect(bucket.store.has(derivedKey)).toBe(true);
		expect(bucket.store.get(derivedKey)?.contentType).toBe('image/jpeg');
		expect(images.calls.filter((c) => c.kind === 'orient')).toHaveLength(1);
		expect(images.calls.filter((c) => c.kind === 'transform')).toHaveLength(1);
	});

	it('does not call Images on a second GET after the derived put', async () => {
		const bucket = memoryBucket();
		await bucket.put(SOURCE_KEY, fakeJpeg());
		const images = stubImages();
		const { ctx, flush } = fakeCtx();
		const deps = {
			bucket,
			images: images.binding,
			waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
		};
		const query = { x: '10', y: '20', w: '30', h: '40' };

		const first = await serveIsolatedItem(tileRequest(query, ctx), deps);
		await flush();
		expect(first.status).toBe(200);
		const callsAfterMiss = images.calls.length;
		expect(callsAfterMiss).toBeGreaterThan(0);

		const second = await serveIsolatedItem(tileRequest(query, ctx), deps);
		await flush();

		expect(second.status).toBe(200);
		expect(await second.arrayBuffer()).toEqual(CROP_JPEG);
		expect(images.calls).toHaveLength(callsAfterMiss);
	});

	it('shares oriented bytes across two boxes on the same source key', async () => {
		const bucket = memoryBucket();
		await bucket.put(SOURCE_KEY, fakeJpeg());
		const images = stubImages();
		const { ctx, flush } = fakeCtx();
		const deps = {
			bucket,
			images: images.binding,
			waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
		};

		await serveIsolatedItem(tileRequest({ x: '10', y: '20', w: '30', h: '40' }, ctx), deps);
		await flush();
		expect(bucket.store.has(isolateOrientedKey(SOURCE_KEY)!)).toBe(true);

		await serveIsolatedItem(tileRequest({ x: '50', y: '20', w: '30', h: '40' }, ctx), deps);
		await flush();

		expect(images.calls.filter((c) => c.kind === 'orient')).toHaveLength(1);
		expect(images.calls.filter((c) => c.kind === 'transform')).toHaveLength(2);
		expect(await isolateDerivedKey(tileCacheParams({ x: '10' }))).not.toBe(
			await isolateDerivedKey(tileCacheParams({ x: '50' })),
		);
	});

	it('rejects path-traversal and absolute keys', async () => {
		const bucket = memoryBucket();
		const images = stubImages();
		const traversal = await serveIsolatedItem(tileRequest({ key: '../secret.jpg' }), {
			bucket,
			images: images.binding,
		});
		const absolute = await serveIsolatedItem(tileRequest({ key: '/absolute.jpg' }), {
			bucket,
			images: images.binding,
		});
		expect(traversal.status).toBe(400);
		expect(absolute.status).toBe(400);
		expect(images.calls).toEqual([]);
	});
});

function tileCacheParams(overrides: { x?: string } = {}) {
	return {
		key: SOURCE_KEY,
		x: parseFloat(overrides.x ?? '10'),
		y: 20,
		w: 30,
		h: 40,
		width: 480,
		cutout: false,
		pad: true,
		category: '',
	};
}

async function tileDerivedKey(query: { x: string; y: string; w: string; h: string }): Promise<string> {
	return isolateDerivedKey({
		key: SOURCE_KEY,
		x: parseFloat(query.x),
		y: parseFloat(query.y),
		w: parseFloat(query.w),
		h: parseFloat(query.h),
		width: 480,
		cutout: false,
		pad: true,
		category: '',
	});
}

function tileRequest(
	query: { key?: string; x?: string; y?: string; w?: string; h?: string },
	ctx?: ExecutionContext,
): ApiRequest {
	const log = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return log;
		},
	};
	return {
		query: {
			key: SOURCE_KEY,
			x: '10',
			y: '20',
			w: '30',
			h: '40',
			width: '480',
			cutout: '0',
			...query,
		},
		log,
		ctx,
	} as unknown as ApiRequest;
}

function fakeCtx() {
	const pending: Promise<unknown>[] = [];
	let waited = false;
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			waited = true;
			pending.push(promise);
		},
		passThroughOnException() {},
		props: {},
	} as ExecutionContext & { waited?: boolean };
	Object.defineProperty(ctx, 'waited', { get: () => waited });
	return {
		ctx,
		async flush() {
			await Promise.all(pending.splice(0));
		},
	};
}

function ctxWaited(ctx: ExecutionContext): boolean {
	return Boolean((ctx as ExecutionContext & { waited?: boolean }).waited);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

function fakeJpeg(width = 200, height = 100): ArrayBuffer {
	return copyArrayBuffer(
		new Uint8Array([
			0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff,
			(width >> 8) & 0xff, width & 0xff, 0x00, 0xff, 0xd9,
		])
	);
}

function stubImages() {
	const calls: Array<{ kind: 'orient' | 'transform'; transforms: unknown[] }> = [];
	const transformer = () => {
		const transforms: unknown[] = [];
		const handle: ImageTransformer = {
			transform(transform) {
				transforms.push(transform);
				return handle;
			},
			draw() {
				return handle;
			},
			async output(options) {
				const kind = transforms.length === 0 ? 'orient' : 'transform';
				calls.push({ kind, transforms: [...transforms] });
				const body = kind === 'orient' ? ORIENTED_JPEG : CROP_JPEG;
				return {
					response: () =>
						new Response(body.slice(0), { headers: { 'content-type': options.format } }),
					contentType: () => options.format,
					image: () => new Blob([body.slice(0)]).stream(),
				};
			},
		};
		return handle;
	};
	const binding: ImagesBinding = {
		input: () => transformer(),
		info: async () => ({
			format: 'image/jpeg',
			fileSize: CROP_JPEG.byteLength,
			width: 80,
			height: 60,
		}),
		hosted: {} as HostedImagesBinding,
	};
	return {
		calls,
		binding,
	};
}

function memoryBucket() {
	const store = new Map<string, { body: ArrayBuffer; contentType?: string }>();
	const puts: string[] = [];
	const bucket = {
		store,
		puts,
		async get(key: string) {
			const row = store.get(key);
			if (!row) return null;
			return {
				key,
				body: new Blob([row.body]).stream(),
				httpEtag: '"etag"',
				httpMetadata: row.contentType ? { contentType: row.contentType } : undefined,
				writeHttpMetadata(headers: Headers) {
					if (row.contentType) headers.set('content-type', row.contentType);
				},
				arrayBuffer: async () => row.body.slice(0),
			};
		},
		async put(key: string, value: R2PutValue, options?: R2PutOptions) {
			puts.push(key);
			store.set(key, {
				body: await toArrayBuffer(value),
				contentType:
					options?.httpMetadata && !(options.httpMetadata instanceof Headers)
						? options.httpMetadata.contentType
						: undefined,
			});
			return { key } as R2Object;
		},
	};
	return bucket as typeof bucket & R2Bucket;
}

type R2PutValue = ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob;

async function toArrayBuffer(value: R2PutValue): Promise<ArrayBuffer> {
	if (value == null) return new ArrayBuffer(0);
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (ArrayBuffer.isView(value)) {
		return copyArrayBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	}
	if (typeof value === 'string') return copyArrayBuffer(new TextEncoder().encode(value));
	if (value instanceof Blob) return value.arrayBuffer();
	return new Response(value).arrayBuffer();
}
