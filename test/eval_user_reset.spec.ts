import { describe, expect, it, vi } from 'vitest';
import {
	assertEvalUserAllowed,
	EvalUserResetError,
	resetEvalUserCloset,
} from '../src/services/identity/eval/resetEvalUser';
import { closetItemVectorId } from '../src/services/identity/encode/vectorize.store';

describe('assertEvalUserAllowed', () => {
	it('requires EVAL_USER_ID to be configured', () => {
		expect(() => assertEvalUserAllowed({}, 'u1')).toThrow(EvalUserResetError);
		try {
			assertEvalUserAllowed({}, 'u1');
		} catch (err) {
			expect(err).toBeInstanceOf(EvalUserResetError);
			expect((err as EvalUserResetError).status).toBe(400);
		}
	});

	it('refuses a userId that is not EVAL_USER_ID', () => {
		expect(() => assertEvalUserAllowed({ EVAL_USER_ID: 'eval-1' }, 'other')).toThrow(/must match/);
		try {
			assertEvalUserAllowed({ EVAL_USER_ID: 'eval-1' }, 'other');
		} catch (err) {
			expect((err as EvalUserResetError).status).toBe(403);
		}
	});

	it('accepts the dedicated eval user', () => {
		expect(assertEvalUserAllowed({ EVAL_USER_ID: 'eval-1' }, 'eval-1')).toBe('eval-1');
		expect(assertEvalUserAllowed({ EVAL_USER_ID: ' eval-1 ' }, 'eval-1')).toBe('eval-1');
	});
});

describe('resetEvalUserCloset', () => {
	it('deletes Vectorize ids then purges D1 for the allowlisted user', async () => {
		const deletedChunks: string[][] = [];
		const index = {
			deleteByIds: async (ids: string[]) => {
				deletedChunks.push(ids);
				return { ids, count: ids.length };
			},
		};
		const closet = {
			listClosetItemIdsForUser: vi.fn(async () => ['c1', 'c2']),
			purgeUserClosetState: vi.fn(async () => ({
				closet_items: 2,
				outfits: 1,
				matches: 0,
				identity_jobs: 0,
				identity_inflight: 0,
				match_notify: 0,
			})),
		};

		const result = await resetEvalUserCloset({
			env: { EVAL_USER_ID: 'eval-1', CLOSET_ITEMS: index as unknown as VectorizeIndex },
			closet: closet as never,
			userId: 'eval-1',
		});

		expect(deletedChunks).toEqual([[closetItemVectorId('c1'), closetItemVectorId('c2')]]);
		expect(closet.purgeUserClosetState).toHaveBeenCalledWith('eval-1');
		expect(result).toMatchObject({
			user_id: 'eval-1',
			closet_item_ids: 2,
			vectors_deleted: 2,
			vectors_failed: 0,
			d1: { closet_items: 2, outfits: 1 },
		});
	});

	it('still purges D1 when Vectorize is unbound', async () => {
		const closet = {
			listClosetItemIdsForUser: vi.fn(async () => ['c1']),
			purgeUserClosetState: vi.fn(async () => ({
				closet_items: 1,
				outfits: 0,
				matches: 0,
				identity_jobs: 0,
				identity_inflight: 0,
				match_notify: 0,
			})),
		};

		const result = await resetEvalUserCloset({
			env: { EVAL_USER_ID: 'eval-1' },
			closet: closet as never,
			userId: 'eval-1',
		});

		expect(result.vectors_deleted).toBe(0);
		expect(closet.purgeUserClosetState).toHaveBeenCalledOnce();
	});
});
