import { describe, expect, it } from 'vitest';
import { FeatureFlags } from '../src/config/featureFlags';
import { flagsForClient, type PostHogFlagSnapshot } from '../src/services/featureFlags.svc';
import { featureUnavailableResponse } from '../src/middlewares/featureFlagMiddleware';

function snapshot(values: Record<string, boolean | string>): PostHogFlagSnapshot {
	return {
		keys: Object.keys(values),
		isEnabled: (key) => values[key] === true,
		getFlag: (key) => values[key],
	};
}

describe('GET /config/features payload', () => {
	it('returns the full flag map for the client', () => {
		const flags = flagsForClient(
			snapshot({
				[FeatureFlags.closetBrowse]: true,
				'copy-test': 'control',
			})
		);
		expect({ flags }).toEqual({
			flags: {
				[FeatureFlags.closetBrowse]: true,
				'copy-test': 'control',
			},
		});
	});

	it('returns an empty map when evaluation failed', () => {
		expect({ flags: flagsForClient(null) }).toEqual({ flags: {} });
	});
});

describe('featureUnavailableResponse', () => {
	it('returns a default FEATURE_UNAVAILABLE code', async () => {
		const response = featureUnavailableResponse();
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			status: 404,
			error: 'Feature is unavailable',
			code: 'STYLENS_FEATURE_UNAVAILABLE',
		});
	});

	it('accepts a closet-specific message and code', async () => {
		const response = featureUnavailableResponse({
			message: 'Closet is unavailable',
			code: 'CLOSET_UNAVAILABLE',
		});
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			status: 404,
			error: 'Closet is unavailable',
			code: 'STYLENS_CLOSET_UNAVAILABLE',
		});
	});
});
