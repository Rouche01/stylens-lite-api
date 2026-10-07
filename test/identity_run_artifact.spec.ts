import { describe, expect, it, vi } from 'vitest';
import {
	IDENTITY_RUN_SINK_DEFAULT_URL,
	buildIdentityRunArtifact,
	persistIdentityRunArtifact,
	shouldPersistIdentityRunArtifact,
} from '../src/services/identity/logging/runArtifact';
import { summarizeIdentityRunItems } from '../src/services/identity/logging/runLogging';
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
		closet_item_id: 'c1',
		is_new_closet_item: true,
		match_id: null,
		candidate_closet_item_id: null,
		identity_score: 0.4,
		...partial,
	};
}

describe('identity run artifacts', () => {
	it('only persists when ENV_NAME is dev', () => {
		expect(shouldPersistIdentityRunArtifact('dev')).toBe(true);
		expect(shouldPersistIdentityRunArtifact('staging')).toBe(false);
		expect(shouldPersistIdentityRunArtifact('production')).toBe(false);
	});

	it('builds a per-run artifact with reviewed=false', () => {
		const summary = summarizeIdentityRunItems([
			item({ identity_status: 'created', identity_reason: 'below_threshold' }),
		]);
		const artifact = buildIdentityRunArtifact({
			identity_run_id: 'run-1',
			envName: 'dev',
			source: 'queue',
			user_id: 'u1',
			image_key: 'users/u1/a.jpg',
			outfit_id: 'o1',
			summary,
			session_id: 's1',
			entry_id: 'e1',
			recorded_at: '2026-10-07T12:00:00.000Z',
		});
		expect(artifact).toMatchObject({
			identity_run_id: 'run-1',
			env: 'dev',
			source: 'queue',
			reviewed: false,
			created: 1,
			asked: 0,
			session_id: 's1',
			entry_id: 'e1',
		});
		expect(artifact.items).toHaveLength(1);
	});

	it('no-ops persist outside dev without calling fetch', async () => {
		const fetchImpl = vi.fn();
		const result = await persistIdentityRunArtifact({
			envName: 'staging',
			fetchImpl: fetchImpl as unknown as typeof fetch,
			artifact: buildIdentityRunArtifact({
				identity_run_id: 'run-1',
				envName: 'staging',
				source: 'extract',
				user_id: 'u1',
				image_key: 'k',
				outfit_id: 'o',
				summary: summarizeIdentityRunItems([]),
			}),
		});
		expect(result).toEqual({ ok: false, reason: 'env_not_dev' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('POSTs to the local sink in dev', async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
		const artifact = buildIdentityRunArtifact({
			identity_run_id: 'run-2',
			envName: 'dev',
			source: 'queue',
			user_id: 'u1',
			image_key: 'k',
			outfit_id: 'o',
			summary: summarizeIdentityRunItems([]),
		});
		const result = await persistIdentityRunArtifact({
			envName: 'dev',
			artifact,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: true });
		expect(fetchImpl).toHaveBeenCalledWith(
			IDENTITY_RUN_SINK_DEFAULT_URL,
			expect.objectContaining({
				method: 'POST',
				headers: { 'content-type': 'application/json' },
			})
		);
		const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);
		expect(body.identity_run_id).toBe('run-2');
	});

	it('fail-opens when the sink is unreachable', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
		const result = await persistIdentityRunArtifact({
			envName: 'dev',
			fetchImpl: fetchImpl as unknown as typeof fetch,
			artifact: buildIdentityRunArtifact({
				identity_run_id: 'run-3',
				envName: 'dev',
				source: 'extract',
				user_id: 'u1',
				image_key: 'k',
				outfit_id: 'o',
				summary: summarizeIdentityRunItems([]),
			}),
		});
		expect(result).toEqual({ ok: false, reason: 'unreachable' });
	});
});
