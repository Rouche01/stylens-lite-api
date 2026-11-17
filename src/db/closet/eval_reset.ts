// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => import('./base').ClosetDBBase;

export type EvalUserClosetPurgeCounts = {
	closet_items: number;
	outfits: number;
	matches: number;
	identity_jobs: number;
	identity_inflight: number;
	match_notify: number;
};

/**
 * Bulk wipe of closet / identity tables for one user (eval cycles).
 * Call Vectorize deletes *before* D1 deletes so ids are still known.
 */
export function WithClosetEvalReset<TBase extends Ctor>(Base: TBase) {
	return class extends Base {
		async listClosetItemIdsForUser(userId: string): Promise<string[]> {
			const result = await this.db
				.prepare(`SELECT id FROM closet_items WHERE user_id = ?`)
				.bind(userId)
				.all<{ id: string }>();
			return (result.results || []).map((row) => row.id).filter(Boolean);
		}

		async purgeUserClosetState(userId: string): Promise<EvalUserClosetPurgeCounts> {
			const run = async (sql: string) => {
				const result = await this.db.prepare(sql).bind(userId).run();
				return result.meta.changes ?? 0;
			};

			// Matches first (FKs to outfits + closet_items).
			const matches = await run(`DELETE FROM closet_item_matches WHERE user_id = ?`);
			// Outfits cascade outfit_clothing_items.
			const outfits = await run(`DELETE FROM outfits WHERE user_id = ?`);
			const closet_items = await run(`DELETE FROM closet_items WHERE user_id = ?`);
			const identity_jobs = await run(`DELETE FROM closet_identity_jobs WHERE user_id = ?`);
			const identity_inflight = await run(`DELETE FROM identity_inflight WHERE user_id = ?`);
			const match_notify = await run(`DELETE FROM closet_match_notify WHERE user_id = ?`);

			return {
				closet_items,
				outfits,
				matches,
				identity_jobs,
				identity_inflight,
				match_notify,
			};
		}
	};
}
