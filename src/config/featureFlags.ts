/**
 * PostHog flag keys this API enforces (gates, 404s, enqueue).
 *
 * Keep shared keys aligned with stylens `FeatureFlags` and the PostHog dashboard.
 * Do not list app-only UI flags here — `GET /config/features` returns the full snapshot.
 */
export const FeatureFlags = {
	closetBrowse: 'closet-browse',
} as const;

export type FeatureFlagKey = (typeof FeatureFlags)[keyof typeof FeatureFlags];
