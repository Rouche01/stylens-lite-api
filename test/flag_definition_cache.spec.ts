import { describe, expect, it, vi } from 'vitest';
import {
	FLAG_DEFINITIONS_CACHE_KEY,
	KvFlagDefinitionCacheReader,
	KvFlagDefinitionCacheWriter,
} from '../src/services/flagDefinitionCache';
import type { FlagDefinitionCacheData } from 'posthog-node';

const sample: FlagDefinitionCacheData = {
	flags: [],
	groupTypeMapping: {},
	cohorts: {},
};

function fakeKv(store: Map<string, string> = new Map()) {
	return {
		async get(key: string, type?: string) {
			const raw = store.get(key);
			if (raw === undefined) return null;
			if (type === 'json') return JSON.parse(raw);
			return raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
	} as unknown as KVNamespace;
}

describe('KvFlagDefinitionCacheReader', () => {
	it('reads definitions from KV and never fetches', async () => {
		const store = new Map([[FLAG_DEFINITIONS_CACHE_KEY, JSON.stringify(sample)]]);
		const reader = new KvFlagDefinitionCacheReader(fakeKv(store));

		await expect(reader.getFlagDefinitions()).resolves.toEqual(sample);
		expect(reader.shouldFetchFlagDefinitions()).toBe(false);
		await expect(reader.onFlagDefinitionsReceived(sample)).rejects.toThrow(/read-only|cannot store/i);
	});

	it('returns undefined when KV is empty or invalid', async () => {
		const reader = new KvFlagDefinitionCacheReader(fakeKv());
		await expect(reader.getFlagDefinitions()).resolves.toBeUndefined();

		const bad = fakeKv(new Map([[FLAG_DEFINITIONS_CACHE_KEY, 'not-json']]));
		bad.get = vi.fn().mockRejectedValue(new Error('parse'));
		const broken = new KvFlagDefinitionCacheReader(bad);
		await expect(broken.getFlagDefinitions()).resolves.toBeUndefined();
	});
});

describe('KvFlagDefinitionCacheWriter', () => {
	it('always fetches and writes definitions', async () => {
		const store = new Map<string, string>();
		const writer = new KvFlagDefinitionCacheWriter(fakeKv(store));

		await expect(writer.getFlagDefinitions()).resolves.toBeUndefined();
		expect(writer.shouldFetchFlagDefinitions()).toBe(true);

		await writer.onFlagDefinitionsReceived(sample);
		expect(store.get(FLAG_DEFINITIONS_CACHE_KEY)).toBe(JSON.stringify(sample));
	});
});
