import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	FAL_MODELS,
	FAL_TIMEOUT_MS,
	FalHttpError,
	falPostJson,
	summarizeFalErrorBody,
} from '../src/services/fal';
import { falBirefnetMatte } from '../src/services/segmentation/providers/fal_birefnet';
import { SegmentError } from '../src/services/segmentation/providers/base.provider';
import { shouldExportLogToPostHog } from '../src/utils/logger.utils';

const ENDPOINT = FAL_MODELS.segmentSam2.endpoint;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('summarizeFalErrorBody', () => {
	it('prefers detail then error then raw body', () => {
		expect(summarizeFalErrorBody('raw', { detail: 'nope' })).toBe('nope');
		expect(summarizeFalErrorBody('raw', { error: 'boom' })).toBe('boom');
		expect(summarizeFalErrorBody('raw body text', null)).toBe('raw body text');
	});
});

describe('FAL_TIMEOUT_MS', () => {
	it('keeps packshot/tryon longer than grounding/segment', () => {
		expect(FAL_TIMEOUT_MS.grounding).toBeLessThan(FAL_TIMEOUT_MS.packshot);
		expect(FAL_TIMEOUT_MS.segment).toBeLessThanOrEqual(FAL_TIMEOUT_MS.tryon);
		expect(FAL_TIMEOUT_MS.packshot).toBe(FAL_TIMEOUT_MS.tryon);
	});
});

describe('FAL_MODELS', () => {
	it('keeps endpoint paths aligned with model ids', () => {
		for (const ref of Object.values(FAL_MODELS)) {
			expect(ref.endpoint.startsWith('https://fal.run/')).toBe(true);
			expect(ref.endpoint.endsWith(ref.model)).toBe(true);
			expect(ref.model.startsWith('fal-ai/')).toBe(true);
		}
	});
});

describe('falPostJson', () => {
	it('throws FalHttpError when FAL_KEY is missing', async () => {
		await expect(
			falPostJson({
				apiKey: '  ',
				endpoint: ENDPOINT,
				useCase: 'segment',
				body: {},
			})
		).rejects.toMatchObject({ name: 'FalHttpError', status: 500, message: 'FAL_KEY is not set' });
	});

	it('returns parsed JSON on success', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ image: { url: 'https://example.com/m.png' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			)
		);

		const result = await falPostJson<{ image: { url: string } }>({
			apiKey: 'test-key',
			endpoint: ENDPOINT,
			model: 'fal-ai/sam2/image',
			useCase: 'segment',
			body: { image_url: 'https://example.com/in.jpg' },
		});

		expect(result.status).toBe(200);
		expect(result.model).toBe('fal-ai/sam2/image');
		expect(result.useCase).toBe('segment');
		expect(result.json.image.url).toContain('example.com');
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		expect(fetchMock).toHaveBeenCalledOnce();
		const init = fetchMock.mock.calls[0]![1] as RequestInit;
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe('Key test-key');
	});

	it('maps HTTP error bodies to FalHttpError with status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ detail: 'quota exceeded' }), {
					status: 429,
					headers: { 'Content-Type': 'application/json' },
				})
			)
		);

		await expect(
			falPostJson({
				apiKey: 'test-key',
				endpoint: ENDPOINT,
				useCase: 'segment',
				body: {},
			})
		).rejects.toMatchObject({
			name: 'FalHttpError',
			status: 429,
			timedOut: false,
		});

		try {
			await falPostJson({
				apiKey: 'test-key',
				endpoint: ENDPOINT,
				useCase: 'segment',
				body: {},
			});
		} catch (err) {
			expect(err).toBeInstanceOf(FalHttpError);
			expect((err as FalHttpError).message).toContain('quota exceeded');
			expect((err as FalHttpError).bodySnippet).toBe('quota exceeded');
		}
	});

	it('times out hung fetches with timedOut FalHttpError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new Error('missing signal'));
						return;
					}
					if (signal.aborted) {
						reject(new DOMException('The operation was aborted', 'AbortError'));
						return;
					}
					signal.addEventListener(
						'abort',
						() => reject(new DOMException('The operation was aborted', 'AbortError')),
						{ once: true }
					);
				});
			})
		);

		await expect(
			falPostJson({
				apiKey: 'test-key',
				endpoint: ENDPOINT,
				useCase: 'grounding',
				timeoutMs: 20,
				body: {},
			})
		).rejects.toMatchObject({
			name: 'FalHttpError',
			status: 504,
			timedOut: true,
		});
	});

	it('exports fal_request_ok on the PostHog info allowlist', () => {
		expect(shouldExportLogToPostHog('info', 'fal_request_ok')).toBe(true);
		expect(shouldExportLogToPostHog('warn', 'fal_request_failed')).toBe(true);
	});
});

describe('adapter error mapping', () => {
	it('falBirefnetMatte surfaces Fal failures as SegmentError', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(JSON.stringify({ detail: 'matte unavailable' }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' },
				})
			)
		);

		await expect(
			falBirefnetMatte({
				apiKey: 'test-key',
				imageUrl: 'https://example.com/cutout.png',
			})
		).rejects.toBeInstanceOf(SegmentError);

		try {
			await falBirefnetMatte({
				apiKey: 'test-key',
				imageUrl: 'https://example.com/cutout.png',
			});
		} catch (err) {
			expect(err).toBeInstanceOf(SegmentError);
			expect((err as SegmentError).status).toBe(502);
			expect((err as SegmentError).message).toContain('matte unavailable');
		}
	});
});
