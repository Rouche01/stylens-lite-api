import { env as defaultEnv } from 'cloudflare:workers';
import { createUsersDB } from '../db';
import { evaluatePostHogFlags, isPostHogFlagEnabled } from './featureFlags.svc';
import { createPostHogFlagClient, type PostHogFlagEnv } from './posthog.svc';

type FeatureFlagGateEnv = PostHogFlagEnv & {
	GOSTYLENS_DB: D1Database;
};

/** Evaluate a boolean PostHog flag for a distinct id (JWT sub). Fail closed. */
export async function isFeatureFlagEnabledForAuthId(
	flagKey: string,
	authId: string | undefined,
	envBindings: FeatureFlagGateEnv = defaultEnv as FeatureFlagGateEnv
): Promise<boolean> {
	const distinctId = authId?.trim();
	const key = flagKey.trim();
	if (!distinctId || !key) return false;

	const client = createPostHogFlagClient(envBindings);
	try {
		const flags = await evaluatePostHogFlags({ client, distinctId });
		return isPostHogFlagEnabled(flags, key);
	} finally {
		await client?.shutdown();
	}
}

/** Resolve users.auth_id then evaluate a boolean flag. Fail closed. */
export async function isFeatureFlagEnabledForUserId(
	flagKey: string,
	userId: string | undefined,
	envBindings: FeatureFlagGateEnv = defaultEnv as FeatureFlagGateEnv
): Promise<boolean> {
	const id = userId?.trim();
	if (!id) return false;

	const user = await createUsersDB(envBindings.GOSTYLENS_DB).getUserById(id);
	return isFeatureFlagEnabledForAuthId(flagKey, user?.auth_id, envBindings);
}
