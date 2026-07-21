import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoltMemClient } from '@voltmem/client';
import { createVoltMemService, isVoltMemWriteTag, VoltMemServiceImpl } from '../src/services/voltmem.svc';
import { createLogger } from '../src/utils/logger.utils';

describe('isVoltMemWriteTag', () => {
	it('accepts prefs, constraint, and occasion tags', () => {
		expect(isVoltMemWriteTag('session_state:user_prefs')).toBe(true);
		expect(isVoltMemWriteTag('session_state:constraint')).toBe(true);
		expect(isVoltMemWriteTag('session_state:occasion')).toBe(true);
	});

	it('rejects outfit image and verdict tags', () => {
		expect(isVoltMemWriteTag('session_state:primary_outfit_image')).toBe(false);
		expect(isVoltMemWriteTag('session_state:alt_outfit_image')).toBe(false);
		expect(isVoltMemWriteTag('session_state:final_verdict')).toBe(false);
	});
});

describe('createVoltMemService', () => {
	it('returns null when URL or API key is missing', () => {
		expect(createVoltMemService({ VOLTMEM_URL: '', VOLTMEM_API_KEY: 'x', ENV_NAME: 'dev' } as Env)).toBeNull();
		expect(createVoltMemService({ VOLTMEM_URL: 'http://127.0.0.1:8080', VOLTMEM_API_KEY: '', ENV_NAME: 'dev' } as Env)).toBeNull();
	});
});

describe('VoltMemServiceImpl', () => {
	const log = createLogger({ env: 'dev' });
	let add: ReturnType<typeof vi.fn>;
	let search: ReturnType<typeof vi.fn>;
	let domainStats: ReturnType<typeof vi.fn>;
	let service: VoltMemServiceImpl;

	beforeEach(() => {
		add = vi.fn().mockResolvedValue({
			id: 'm1',
			memory: 'Prefers darker colors',
			action: 'ADD',
			domain: 'style_preference',
			detail: '',
		});
		search = vi.fn().mockResolvedValue([]);
		domainStats = vi.fn().mockResolvedValue({});
		const client = {
			add,
			search,
			domainStats,
		} as unknown as VoltMemClient;
		service = new VoltMemServiceImpl(client, log);
	});

	it('rememberFromTag maps write tags to client.add with summary', async () => {
		await service.rememberFromTag('user-1', 'session_state:user_prefs', 'Prefers darker colors');
		expect(add).toHaveBeenCalledWith('Prefers darker colors', {
			userId: 'user-1',
			source: 'classification',
		});
	});

	it('rememberFromTag no-ops for outfit image tags', async () => {
		const result = await service.rememberFromTag(
			'user-1',
			'session_state:primary_outfit_image',
			'Primary outfit'
		);
		expect(result).toBeNull();
		expect(add).not.toHaveBeenCalled();
	});

	it('searchPrefs returns empty on failure (fail-open)', async () => {
		search.mockRejectedValueOnce(new Error('sidecar down'));
		await expect(service.searchPrefs('user-1', 'style preferences')).resolves.toEqual([]);
	});

	it('domainStats returns null on failure (fail-open)', async () => {
		domainStats.mockRejectedValueOnce(new Error('sidecar down'));
		await expect(service.domainStats('user-1')).resolves.toBeNull();
	});
});
