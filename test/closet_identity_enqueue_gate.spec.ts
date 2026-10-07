import { describe, expect, it, vi } from 'vitest';
import {
	resolveClosetIdentityEnqueueGate,
	resolveClosetIdentityEnqueuePrecheck,
} from '../src/services/classification.svc';
import type { StyleEntryTag } from '../src/db/types';

describe('resolveClosetIdentityEnqueuePrecheck', () => {
	const outfitTags: StyleEntryTag[] = [
		{ tag: 'session_state:primary_outfit_image', payload: { summary: 'outfit' } },
	];

	it('skips when there is no outfit tag', () => {
		expect(
			resolveClosetIdentityEnqueuePrecheck({
				userId: 'u1',
				hasIdentityEnqueue: true,
				tags: [{ tag: 'session_state:occasion', payload: { occasion: 'wedding' } }],
			})
		).toEqual({ action: 'skip', reason: 'no_outfit_tag' });
	});

	it('skips when user or enqueue wiring is missing', () => {
		expect(
			resolveClosetIdentityEnqueuePrecheck({
				userId: undefined,
				hasIdentityEnqueue: true,
				tags: outfitTags,
			})
		).toEqual({ action: 'skip', reason: 'missing_user_or_enqueue' });
		expect(
			resolveClosetIdentityEnqueuePrecheck({
				userId: 'u1',
				hasIdentityEnqueue: false,
				tags: outfitTags,
			})
		).toEqual({ action: 'skip', reason: 'missing_user_or_enqueue' });
	});

	it('continues when outfit-tagged and enqueue is wired', () => {
		expect(
			resolveClosetIdentityEnqueuePrecheck({
				userId: '  u1  ',
				hasIdentityEnqueue: true,
				tags: outfitTags,
			})
		).toEqual({ action: 'continue' });
	});
});

describe('resolveClosetIdentityEnqueueGate', () => {
	it('skips when auth id is missing', async () => {
		await expect(
			resolveClosetIdentityEnqueueGate({
				authId: undefined,
				closetBrowseEnabled: vi.fn().mockResolvedValue(true),
			})
		).resolves.toEqual({ action: 'skip', reason: 'missing_auth_id' });
	});

	it('skips when the flag gate is unavailable', async () => {
		await expect(
			resolveClosetIdentityEnqueueGate({
				authId: 'auth-1',
				closetBrowseEnabled: null,
			})
		).resolves.toEqual({ action: 'skip', reason: 'flag_gate_unavailable' });
	});

	it('skips when closet-browse is off', async () => {
		const closetBrowseEnabled = vi.fn().mockResolvedValue(false);
		await expect(
			resolveClosetIdentityEnqueueGate({
				authId: 'auth-1',
				closetBrowseEnabled,
			})
		).resolves.toEqual({ action: 'skip', reason: 'closet_browse_off' });
		expect(closetBrowseEnabled).toHaveBeenCalledWith('auth-1');
	});

	it('enqueues when closet-browse is on', async () => {
		const closetBrowseEnabled = vi.fn().mockResolvedValue(true);
		await expect(
			resolveClosetIdentityEnqueueGate({
				authId: '  auth-1  ',
				closetBrowseEnabled,
			})
		).resolves.toEqual({ action: 'enqueue' });
		expect(closetBrowseEnabled).toHaveBeenCalledWith('auth-1');
	});
});
