import { describe, expect, it } from 'vitest';
import { notifyClosetCatalogIfChanged } from '../src/services/identity/notify/catalogBroadcast';
import type { Logger } from '../src/utils/logger.utils';

describe('notifyClosetCatalogIfChanged', () => {
	it('broadcasts browse ids once and logs count without item payloads', async () => {
		const realtime = memoryCatalogRealtime();
		const log = capturingLogger();

		const sent = await notifyClosetCatalogIfChanged({
			userId: 'u1',
			outfitId: 'outfit-1',
			items: [
				{ closet_item_id: 'top-1', identity_status: 'created', category: 'top', subcategory: 'shirt' },
				{ closet_item_id: 'socks-1', identity_status: 'created', category: 'accessory', subcategory: 'socks' },
			],
			realtime,
			log,
		});

		expect(sent).toBe(true);
		expect(realtime.events).toEqual([
			{
				userId: 'u1',
				payload: {
					reason: 'identity',
					outfit_id: 'outfit-1',
					closet_item_ids: ['top-1'],
				},
			},
		]);
		expect(log.infos).toEqual([
			{
				event: 'closet_catalog_broadcast',
				fields: { user_id: 'u1', outfit_id: 'outfit-1', closet_item_id_count: 1 },
			},
		]);
	});

	it('does not broadcast when every item is ask, failed, or excluded', async () => {
		const realtime = memoryCatalogRealtime();

		const sent = await notifyClosetCatalogIfChanged({
			userId: 'u1',
			outfitId: 'outfit-1',
			items: [
				{ closet_item_id: null, identity_status: 'ask', category: 'top', subcategory: 'shirt' },
				{ closet_item_id: 'socks-1', identity_status: 'created', category: 'accessory', subcategory: 'socks' },
			],
			realtime,
			log: silentLogger(),
		});

		expect(sent).toBe(false);
		expect(realtime.events).toHaveLength(0);
	});

	it('swallows broadcast errors', async () => {
		const sent = await notifyClosetCatalogIfChanged({
			userId: 'u1',
			outfitId: 'outfit-1',
			items: [{ closet_item_id: 'top-1', identity_status: 'created', category: 'top', subcategory: 'shirt' }],
			realtime: {
				async notifyClosetCatalogUpdated() {
					throw new Error('realtime down');
				},
			},
			log: silentLogger(),
		});

		expect(sent).toBe(false);
	});
});

function memoryCatalogRealtime() {
	const events: Array<{
		userId: string;
		payload: { reason: 'identity'; outfit_id: string | null; closet_item_ids: string[] };
	}> = [];
	return {
		events,
		async notifyClosetCatalogUpdated(
			userId: string,
			payload: (typeof events)[number]['payload']
		) {
			events.push({ userId, payload });
		},
	};
}

function capturingLogger(): Logger & {
	infos: Array<{ event: string; fields?: Record<string, unknown> }>;
} {
	const infos: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const log: Logger & { infos: typeof infos } = {
		infos,
		debug() {},
		info(event, fields) {
			infos.push({ event, fields: fields as Record<string, unknown> | undefined });
		},
		warn() {},
		error() {},
		child() {
			return log;
		},
	};
	return log;
}

function silentLogger(): Logger {
	const log: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return log;
		},
	};
	return log;
}
