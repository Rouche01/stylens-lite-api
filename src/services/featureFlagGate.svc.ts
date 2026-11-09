import { env as defaultEnv } from 'cloudflare:workers';
import { createUsersDB } from '../db';
import {
	evaluatePostHogFlags,
	isPostHogFlagEnabled,
	resolveFeatureFlagSnapshot,
} from './featureFlags.svc';
import { createPostHogFlagClient, type PostHogFlagEnv } from './posthog.svc';

type FeatureFlagGateEnv = PostHogFlagEnv & {
	GOSTYLENS_DB: D1Database;
	ENV_NAME?: Env['ENV_NAME'];
	FEATURE_FLAG_OVERRIDES?: string;
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
		const resolved = resolveFeatureFlagSnapshot({
			flags,
			envName: envBindings.ENV_NAME,
			overridesRaw: envBindings.FEATURE_FLAG_OVERRIDES,
		});
		return isPostHogFlagEnabled(resolved, key);
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
