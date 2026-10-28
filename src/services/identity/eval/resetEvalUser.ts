import { ClosetDB } from 'db/closet';
import { closetItemVectorId, ClosetVectorStore } from '../encode/vectorize.store';
import type { Logger } from 'utils/logger.utils';
import type { EvalUserClosetPurgeCounts } from 'db/closet/eval_reset';

const VECTOR_DELETE_CHUNK = 64;

export type ResetEvalUserEnv = {
	EVAL_USER_ID?: string;
	CLOSET_ITEMS?: VectorizeIndex;
};

export type ResetEvalUserResult = {
	user_id: string;
	closet_item_ids: number;
	vectors_deleted: number;
	vectors_failed: number;
	vector_sweep_rounds: number;
	d1: EvalUserClosetPurgeCounts;
};

export class EvalUserResetError extends Error {
	constructor(
		message: string,
		public status: number
	) {
		super(message);
		this.name = 'EvalUserResetError';
	}
}

/** Only the configured EVAL_USER_ID may be wiped. */
export function assertEvalUserAllowed(env: ResetEvalUserEnv, userId: string): string {
	const allowed = env.EVAL_USER_ID?.trim();
	const requested = userId.trim();
	if (!allowed) {
		throw new EvalUserResetError(
			'EVAL_USER_ID is not configured. Set it in .dev.vars to a dedicated eval account.',
			400
		);
	}
	if (!requested) {
		throw new EvalUserResetError('userId is required', 400);
	}
	if (requested !== allowed) {
		throw new EvalUserResetError(
			'Refusing reset: userId must match EVAL_USER_ID (dedicated eval account only)',
			403
		);
	}
	return requested;
}

export async function resetEvalUserCloset(params: {
	env: ResetEvalUserEnv;
	closet: ClosetDB;
	userId: string;
	log?: Logger;
}): Promise<ResetEvalUserResult> {
	const userId = assertEvalUserAllowed(params.env, params.userId);
	const log = params.log?.child({ service: 'eval_reset', user_id: userId });

	const closetItemIds = await params.closet.listClosetItemIdsForUser(userId);
	let vectorsDeleted = 0;
	let vectorsFailed = 0;
	let vectorSweepRounds = 0;

	const index = params.env.CLOSET_ITEMS;
	if (index) {
		const store = new ClosetVectorStore(index);

		// Fast path: ids still known in D1.
		if (closetItemIds.length > 0) {
			const vectorIds = closetItemIds.map((id) => closetItemVectorId(id));
			for (let i = 0; i < vectorIds.length; i += VECTOR_DELETE_CHUNK) {
				const chunk = vectorIds.slice(i, i + VECTOR_DELETE_CHUNK);
				try {
					await store.deleteByIds(chunk);
					vectorsDeleted += chunk.length;
				} catch (err) {
					vectorsFailed += chunk.length;
					log?.warn('eval_reset_vector_chunk_failed', { chunk_size: chunk.length }, err);
				}
			}
		}

		// Catch orphans (and anything re-upserted / missing from D1 list).
		// settleMs: Vectorize mutations lag; pause between query rounds so eval cycles start clean.
		try {
			const sweep = await store.deleteByUserId(userId, { settleMs: 400 });
			vectorsDeleted += sweep.deleted;
			vectorsFailed += sweep.failed;
			vectorSweepRounds = sweep.rounds;
			log?.info('eval_reset_vector_sweep', {
				deleted: sweep.deleted,
				failed: sweep.failed,
				rounds: sweep.rounds,
			});
		} catch (err) {
			log?.warn('eval_reset_vector_sweep_failed', {}, err);
			vectorsFailed += 1;
		}
	} else if (closetItemIds.length > 0) {
		log?.warn('eval_reset_vectorize_unbound', { closet_item_count: closetItemIds.length });
	}

	const d1 = await params.closet.purgeUserClosetState(userId);
	log?.info('eval_user_closet_reset', {
		closet_item_ids: closetItemIds.length,
		vectors_deleted: vectorsDeleted,
		vectors_failed: vectorsFailed,
		vector_sweep_rounds: vectorSweepRounds,
		d1_closet_items: d1.closet_items,
		d1_outfits: d1.outfits,
		d1_matches: d1.matches,
	});

	return {
		user_id: userId,
		closet_item_ids: closetItemIds.length,
		vectors_deleted: vectorsDeleted,
		vectors_failed: vectorsFailed,
		vector_sweep_rounds: vectorSweepRounds,
		d1,
	};
}
