import { describe, expect, it, vi } from 'vitest';
import { isExpectedClientError, logRouteError } from '../src/utils/error';
import { createLogger, distinctIdFromLogContext } from '../src/utils/logger.utils';

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
