import type { FlagDefinitionCacheData, FlagDefinitionCacheProvider } from 'posthog-node';

export const FLAG_DEFINITIONS_CACHE_KEY = 'posthog:flag_definitions';

/**
 * Shared Cloudflare KV store for PostHog flag definitions.
 * Prefer {@link createKvFlagDefinitionCacheReader} on request paths and
 * {@link createKvFlagDefinitionCacheWriter} on the scheduled refresh.
 */
class KvFlagDefinitionCache implements FlagDefinitionCacheProvider {
	constructor(protected readonly kv: KVNamespace) {}

	async getFlagDefinitions(): Promise<FlagDefinitionCacheData | undefined> {
		try {
			const cached = await this.kv.get(FLAG_DEFINITIONS_CACHE_KEY, 'json');
			if (!cached || typeof cached !== 'object') return undefined;
			return cached as FlagDefinitionCacheData;
		} catch {
			return undefined;
		}
	}

	shouldFetchFlagDefinitions(): boolean {
		return false;
	}

	async onFlagDefinitionsReceived(data: FlagDefinitionCacheData): Promise<void> {
		await this.kv.put(FLAG_DEFINITIONS_CACHE_KEY, JSON.stringify(data));
	}

	shutdown(): void {
		// KV bindings need no cleanup.
	}
}

/** Request-path cache: read KV only. Never fetch or write definitions. */
export class KvFlagDefinitionCacheReader extends KvFlagDefinitionCache {
	override shouldFetchFlagDefinitions(): boolean {
		return false;
	}

	override async onFlagDefinitionsReceived(): Promise<void> {
		throw new Error('KvFlagDefinitionCacheReader cannot store flag definitions');
	}
}

/** Cron-path cache: always fetch from PostHog and overwrite KV. */
export class KvFlagDefinitionCacheWriter extends KvFlagDefinitionCache {
	override getFlagDefinitions(): Promise<FlagDefinitionCacheData | undefined> {
		return Promise.resolve(undefined);
	}

	override shouldFetchFlagDefinitions(): boolean {
		return true;
	}
}

export function createKvFlagDefinitionCacheReader(kv: KVNamespace): FlagDefinitionCacheProvider {
	return new KvFlagDefinitionCacheReader(kv);
}

export function createKvFlagDefinitionCacheWriter(kv: KVNamespace): FlagDefinitionCacheProvider {
	return new KvFlagDefinitionCacheWriter(kv);
}
