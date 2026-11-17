import { VoltMemClient, type DomainStats, type MemoryHit, type WriteResult } from '@voltmem/client';
import { Logger, createLogger, serializeError } from '../utils/logger.utils';
import type { StyleEntryTagName } from '../db/types';

/** Text classification tags that map to cross-session VoltMem facts (v1). */
const VOLTMEM_WRITE_TAGS = new Set<StyleEntryTagName>([
	'session_state:user_prefs',
	'session_state:constraint',
	'session_state:occasion',
]);

export type VoltMemService = {
	rememberFromTag(
		userId: string,
		tag: StyleEntryTagName | string,
		summary: string
	): Promise<WriteResult | WriteResult[] | null>;
	searchPrefs(userId: string, query: string, limit?: number): Promise<MemoryHit[]>;
	domainStats(userId: string): Promise<DomainStats | null>;
};

export function isVoltMemWriteTag(tag: string): boolean {
	return VOLTMEM_WRITE_TAGS.has(tag as StyleEntryTagName);
}

export class VoltMemServiceImpl implements VoltMemService {
	constructor(
		private client: VoltMemClient,
		private log: Logger
	) {}

	async rememberFromTag(
		userId: string,
		tag: StyleEntryTagName | string,
		summary: string
	): Promise<WriteResult | WriteResult[] | null> {
		if (!isVoltMemWriteTag(tag)) {
			return null;
		}
		const text = summary?.trim();
		if (!text) {
			return null;
		}

		try {
			const result = await this.client.add(text, { userId, source: 'classification' });
			this.log.info('voltmem_add_ok', {
				user_id: userId,
				tag,
				action: Array.isArray(result) ? result.map((r) => r.action).join(',') : result.action,
			});
			return result;
		} catch (err) {
			this.log.warn('voltmem_add_failed', { user_id: userId, tag, ...serializeError(err) }, err);
			return null;
		}
	}

	async searchPrefs(userId: string, query: string, limit = 5): Promise<MemoryHit[]> {
		try {
			return await this.client.search(query, { userId, limit });
		} catch (err) {
			this.log.warn('voltmem_search_failed', { user_id: userId, ...serializeError(err) }, err);
			return [];
		}
	}

	async domainStats(userId: string): Promise<DomainStats | null> {
		try {
			return await this.client.domainStats({ userId });
		} catch (err) {
			this.log.warn('voltmem_domain_stats_failed', { user_id: userId, ...serializeError(err) }, err);
			return null;
		}
	}
}

/**
 * Fail-open factory: returns null when URL/key are missing so style stream still works.
 */
export const createVoltMemService = (env: Env, log?: Logger): VoltMemService | null => {
	const baseUrl = env.VOLTMEM_URL?.trim();
	const apiKey = env.VOLTMEM_API_KEY?.trim();
	if (!baseUrl || !apiKey) {
		return null;
	}

	const logger = (log ?? createLogger({ env: env.ENV_NAME })).child({ service: 'voltmem' });
	const client = new VoltMemClient({ baseUrl, apiKey });
	return new VoltMemServiceImpl(client, logger);
};
