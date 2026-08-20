import { describe, expect, it, vi } from 'vitest';
import { isExpectedClientError, logRouteError } from '../src/utils/error';
import { createLogger, distinctIdFromLogContext, shouldExportLogToPostHog } from '../src/utils/logger.utils';

describe('isExpectedClientError', () => {
	it('treats known business errors as expected', () => {
		expect(isExpectedClientError(new Error('FREE_LIMIT_REACHED'))).toBe(true);
		expect(isExpectedClientError(new Error('Session NOT_FOUND'))).toBe(true);
		expect(isExpectedClientError(new Error('IMAGE_UPLOAD_TIMEOUT'))).toBe(true);
	});

	it('treats ImageUploadTimeoutError by name as expected', () => {
		const err = new Error('Timeout waiting for images: foo');
		err.name = 'ImageUploadTimeoutError';
		expect(isExpectedClientError(err)).toBe(true);
	});

	it('treats unexpected failures as not expected', () => {
		expect(isExpectedClientError(new Error('D1_ERROR: database is locked'))).toBe(false);
		expect(isExpectedClientError('boom')).toBe(false);
	});
});

describe('distinctIdFromLogContext', () => {
	it('prefers auth_id over user_id', () => {
		expect(distinctIdFromLogContext({ auth_id: 'auth-1', user_id: 'db-1' })).toBe('auth-1');
	});

	it('falls back to anonymous', () => {
		expect(distinctIdFromLogContext({})).toBe('anonymous');
	});
});

describe('shouldExportLogToPostHog', () => {
	it('exports warn and error always', () => {
		expect(shouldExportLogToPostHog('warn', 'anything')).toBe(true);
		expect(shouldExportLogToPostHog('error', 'anything')).toBe(true);
	});

	it('exports allowlisted info messages only', () => {
		expect(shouldExportLogToPostHog('info', 'fcm_send_complete')).toBe(true);
		expect(shouldExportLogToPostHog('info', 'request_completed')).toBe(false);
		expect(shouldExportLogToPostHog('info', 'random_debug_line')).toBe(false);
	});

	it('does not export debug', () => {
		expect(shouldExportLogToPostHog('debug', 'fcm_send_complete')).toBe(false);
	});
});

describe('PostHog logger sink', () => {
	it('forwards allowlisted info to the sink but not other info lines', () => {
		const emitLog = vi.fn();
		const sink = {
			emitLog,
			captureException: vi.fn(),
			flush: vi.fn(),
		};
		const log = createLogger({ env: 'dev', sink });

		log.info('fcm_send_complete', { tokens_sent: 1 });
		log.info('request_completed', { status: 200 });

		expect(emitLog).toHaveBeenCalledOnce();
		expect(emitLog.mock.calls[0]?.[0]).toBe('info');
		expect(emitLog.mock.calls[0]?.[1]).toBe('fcm_send_complete');
	});
});

describe('logRouteError', () => {
	it('warns for expected client errors and errors otherwise', () => {
		const warn = vi.fn();
		const error = vi.fn();
		const log = createLogger({ env: 'dev' });
		log.warn = warn;
		log.error = error;

		logRouteError(log, 'create_session_failed', new Error('FREE_LIMIT_REACHED'));
		logRouteError(log, 'create_session_failed', new Error('D1 exploded'));

		expect(warn).toHaveBeenCalledOnce();
		expect(error).toHaveBeenCalledOnce();
	});
});
