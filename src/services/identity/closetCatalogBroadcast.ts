import {
	closetCatalogNotifyFromProcessedItems,
	type ClosetCatalogNotifyItem,
} from '../../utils/closet_browse';
import type { Logger } from '../../utils/logger.utils';

export type ClosetCatalogUpdatedPayload = {
	reason: 'identity';
	outfit_id: string | null;
	closet_item_ids: string[];
};

export type ClosetCatalogNotifier = {
	notify(params: {
		userId: string;
		outfitId: string | null;
		items: readonly ClosetCatalogNotifyItem[];
	}): Promise<void>;
};

export async function notifyClosetCatalogIfChanged(params: {
	userId: string;
	outfitId: string | null;
	items: readonly ClosetCatalogNotifyItem[];
	realtime: {
		notifyClosetCatalogUpdated(userId: string, payload: ClosetCatalogUpdatedPayload): Promise<void>;
	};
	log: Logger;
}): Promise<boolean> {
	const { closet_item_ids } = closetCatalogNotifyFromProcessedItems(params.items);
	if (closet_item_ids.length === 0) {
		return false;
	}

	try {
		await params.realtime.notifyClosetCatalogUpdated(params.userId, {
			reason: 'identity',
			outfit_id: params.outfitId,
			closet_item_ids,
		});
		params.log.info('closet_catalog_broadcast', {
			user_id: params.userId,
			outfit_id: params.outfitId,
			closet_item_id_count: closet_item_ids.length,
		});
		return true;
	} catch (err) {
		params.log.warn(
			'closet_catalog_broadcast_failed',
			{
				user_id: params.userId,
				outfit_id: params.outfitId,
				closet_item_id_count: closet_item_ids.length,
			},
			err
		);
		return false;
	}
}

export function createClosetCatalogNotifier(
	realtime: {
		notifyClosetCatalogUpdated(userId: string, payload: ClosetCatalogUpdatedPayload): Promise<void>;
	},
	log: Logger
): ClosetCatalogNotifier {
	return {
		async notify(params) {
			await notifyClosetCatalogIfChanged({
				userId: params.userId,
				outfitId: params.outfitId,
				items: params.items,
				realtime,
				log,
			});
		},
	};
}
