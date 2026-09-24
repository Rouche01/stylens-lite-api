import { describe, expect, it, vi } from 'vitest';
import { resolveClosetIdentityEnqueueGate } from '../src/services/classification.svc';

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
