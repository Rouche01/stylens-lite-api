import { describe, expect, it, vi } from 'vitest';
import { FeatureFlags } from '../src/config/featureFlags';
import {
	evaluatePostHogFlags,
	flagValue,
	flagsForClient,
	isPostHogFlagEnabled,
	parseFeatureFlagOverrides,
	resolveFeatureFlagSnapshot,
	type PostHogFlagSnapshot,
} from '../src/services/featureFlags.svc';

function snapshot(values: Record<string, boolean | string>): PostHogFlagSnapshot {
	return {
		keys: Object.keys(values),
		isEnabled: (key) => values[key] === true,
		getFlag: (key) => values[key],
	};
}

describe('evaluatePostHogFlags', () => {
	it('returns the snapshot when evaluation succeeds', async () => {
		const flags = snapshot({ [FeatureFlags.closetBrowse]: true, 'copy-test': 'control' });
		const client = { evaluateFlags: vi.fn().mockResolvedValue(flags) };

		await expect(
			evaluatePostHogFlags({ client, distinctId: 'auth-1', personProperties: { email: 'a@b.c' } })
		).resolves.toBe(flags);
		expect(client.evaluateFlags).toHaveBeenCalledWith('auth-1', {
			groups: undefined,
			personProperties: { email: 'a@b.c' },
		});
	});

	it('returns null for a null client', async () => {
		await expect(evaluatePostHogFlags({ client: null, distinctId: 'auth-1' })).resolves.toBeNull();
	});

	it('returns null when distinct id is blank', async () => {
		const client = { evaluateFlags: vi.fn() };
		await expect(evaluatePostHogFlags({ client, distinctId: '  ' })).resolves.toBeNull();
		expect(client.evaluateFlags).not.toHaveBeenCalled();
	});

	it('returns null when evaluation throws', async () => {
		const client = { evaluateFlags: vi.fn().mockRejectedValue(new Error('down')) };
		await expect(evaluatePostHogFlags({ client, distinctId: 'auth-1' })).resolves.toBeNull();
	});

	it('returns null when evaluation times out', async () => {
		const client = { evaluateFlags: vi.fn().mockReturnValue(new Promise(() => undefined)) };
		await expect(evaluatePostHogFlags({ client, distinctId: 'auth-1', timeoutMs: 20 })).resolves.toBeNull();
	});
});

describe('flag readers', () => {
	const flags = snapshot({
		[FeatureFlags.closetBrowse]: true,
		'other-flag': false,
		'copy-test': 'variant-a',
	});

	it('reads booleans and variants', () => {
		expect(isPostHogFlagEnabled(flags, FeatureFlags.closetBrowse)).toBe(true);
		expect(isPostHogFlagEnabled(flags, 'other-flag')).toBe(false);
		expect(isPostHogFlagEnabled(flags, 'copy-test')).toBe(false);
		expect(isPostHogFlagEnabled(flags, 'missing')).toBe(false);
		expect(flagValue(flags, 'copy-test')).toBe('variant-a');
		expect(flagValue(flags, 'missing')).toBeUndefined();
	});

	it('fails closed when the snapshot is null', () => {
		expect(isPostHogFlagEnabled(null, FeatureFlags.closetBrowse)).toBe(false);
		expect(flagValue(null, FeatureFlags.closetBrowse)).toBeUndefined();
		expect(flagsForClient(null)).toEqual({});
	});

	it('builds the client map from booleans and variant strings', () => {
		expect(flagsForClient(flags)).toEqual({
			[FeatureFlags.closetBrowse]: true,
			'other-flag': false,
			'copy-test': 'variant-a',
		});
	});
});

describe('dev feature flag overrides', () => {
	it('parses boolean and string overrides', () => {
		expect(parseFeatureFlagOverrides('{"closet-browse":true,"copy-test":"control"}')).toEqual({
			'closet-browse': true,
			'copy-test': 'control',
		});
	});

	it('returns empty for invalid JSON', () => {
		expect(parseFeatureFlagOverrides('{')).toEqual({});
		expect(parseFeatureFlagOverrides('[]')).toEqual({});
		expect(parseFeatureFlagOverrides(undefined)).toEqual({});
	});

	it('merges overrides only when ENV_NAME is dev', () => {
		const base = snapshot({ [FeatureFlags.closetBrowse]: false, 'copy-test': 'control' });
		const raw = '{"closet-browse":true,"new-flag":"on"}';

		const resolved = resolveFeatureFlagSnapshot({
			flags: base,
			envName: 'dev',
			overridesRaw: raw,
		});
		expect(flagsForClient(resolved)).toEqual({
			[FeatureFlags.closetBrowse]: true,
			'copy-test': 'control',
			'new-flag': 'on',
		});

		expect(
			resolveFeatureFlagSnapshot({
				flags: base,
				envName: 'staging',
				overridesRaw: raw,
			})
		).toBe(base);
	});

	it('applies overrides when PostHog evaluation returned null', () => {
		const resolved = resolveFeatureFlagSnapshot({
			flags: null,
			envName: 'dev',
			overridesRaw: '{"closet-browse":true}',
		});
		expect(isPostHogFlagEnabled(resolved, FeatureFlags.closetBrowse)).toBe(true);
		expect(flagsForClient(resolved)).toEqual({ [FeatureFlags.closetBrowse]: true });
	});
});
