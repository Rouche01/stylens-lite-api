import { describe, expect, it } from 'vitest';
import {
	IDENTITY_RUN_ITEMS_LOG_CAP,
	IdentityRunLogEvents,
	identityRunChildContext,
	identityRunCompletedLogContext,
	joinImageKeysForLog,
	mintIdentityRunId,
	summarizeIdentityRunItems,
} from '../src/services/identity/logging/runLogging';
import type { ProcessedOutfitItem } from '../src/services/identity/write/types';
import {
	ClothingItemCategory,
	ClothingItemPattern,
	ClothingItemSubcategory,
	ExtractionConfidence,
} from '../src/types';

function item(
	partial: Partial<ProcessedOutfitItem> & Pick<ProcessedOutfitItem, 'identity_status' | 'identity_reason'>
): ProcessedOutfitItem {
	return {
		label: 'Tee',
		category: ClothingItemCategory.TOP,
		subcategory: ClothingItemSubcategory.SHIRT,
		color: 'olive',
		pattern: ClothingItemPattern.SOLID,
		style_tags: [],
		confidence: ExtractionConfidence.HIGH,
		bounding_box: { x: 10, y: 10, width: 40, height: 40 },
		closet_item_id: null,
		is_new_closet_item: false,
		match_id: null,
		candidate_closet_item_id: null,
		identity_score: null,
		identity_cosine: null,
		identity_color_distance: null,
		...partial,
	};
}

describe('identity run logging contract', () => {
	it('mints a uuid identity_run_id', () => {
		const id = mintIdentityRunId();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
	});

	it('builds child context without empty optional fields', () => {
		expect(
			identityRunChildContext({
				identity_run_id: 'run-1',
				user_id: '  u1  ',
				image_key: '',
				session_id: 's1',
			})
		).toEqual({
			identity_run_id: 'run-1',
			user_id: 'u1',
			session_id: 's1',
		});
	});

	it('summarizes create / ask / failed / existing_crop separately', () => {
		const summary = summarizeIdentityRunItems([
			item({
				identity_status: 'created',
				identity_reason: 'below_threshold',
				identity_score: 0.4,
				closet_item_id: 'c1',
				is_new_closet_item: true,
			}),
			item({
				identity_status: 'ask',
				identity_reason: 'ask',
				identity_score: 0.7,
				candidate_closet_item_id: 'cand',
			}),
			item({
				identity_status: 'failed',
				identity_reason: 'embed_failed',
			}),
			item({
				identity_status: 'created',
				identity_reason: 'existing_crop',
				closet_item_id: 'c2',
			}),
		]);

		expect(summary).toMatchObject({
			item_count: 4,
			created: 1,
			asked: 1,
			failed: 1,
			existing_crop: 1,
			items_truncated: false,
		});
		expect(summary.items[0]).toMatchObject({
			label: 'Tee',
			category: 'top',
			identity_status: 'created',
			identity_reason: 'below_threshold',
			identity_score: 0.4,
			identity_cosine: null,
			identity_color_distance: null,
			closet_item_id: 'c1',
		});
	});

	it(`truncates item rows at ${IDENTITY_RUN_ITEMS_LOG_CAP}`, () => {
		const many = Array.from({ length: IDENTITY_RUN_ITEMS_LOG_CAP + 3 }, (_, i) =>
			item({
				identity_status: 'created',
				identity_reason: 'no_neighbor',
				label: `Item ${i}`,
			})
		);
		const summary = summarizeIdentityRunItems(many);
		expect(summary.item_count).toBe(IDENTITY_RUN_ITEMS_LOG_CAP + 3);
		expect(summary.created).toBe(IDENTITY_RUN_ITEMS_LOG_CAP + 3);
		expect(summary.items).toHaveLength(IDENTITY_RUN_ITEMS_LOG_CAP);
		expect(summary.items_truncated).toBe(true);
	});

	it('flattens completed context with items_json (no nested arrays)', () => {
		const summary = summarizeIdentityRunItems([
			item({
				identity_status: 'created',
				identity_reason: 'no_neighbor',
				closet_item_id: 'c1',
				is_new_closet_item: true,
			}),
		]);
		const ctx = identityRunCompletedLogContext({
			identity_run_id: 'run-1',
			user_id: 'u1',
			image_key: 'users/u1/a.jpg',
			outfit_id: 'o1',
			summary,
		});
		expect(ctx.items_json).toEqual(JSON.stringify(summary.items));
		expect(ctx.item_count).toBe(1);
		expect(ctx.created).toBe(1);
		expect(Object.values(ctx).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))).toBe(
			true
		);
	});

	it('joins image keys for scalar logs', () => {
		expect(joinImageKeysForLog(['a.jpg', '', '  ', 'b.jpg'])).toBe('a.jpg,b.jpg');
	});

	it('exposes stable event names', () => {
		expect(IdentityRunLogEvents.JOB_COMPLETED).toBe('closet_identity_completed');
		expect(IdentityRunLogEvents.ENQUEUE_RESULT).toBe('closet_identity_enqueue_result');
	});
});
