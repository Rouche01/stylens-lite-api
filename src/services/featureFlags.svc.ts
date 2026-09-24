import type { AllFlagsOptions, PostHog } from 'posthog-node';

export const FLAG_EVALUATION_TIMEOUT_MS = 2_000;

export type PostHogFlagSnapshot = {
	isEnabled(key: string): boolean;
	getFlag(key: string): boolean | string | undefined;
	readonly keys: readonly string[];
};

type EvaluateFlagsClient = {
	evaluateFlags(distinctId: string, options?: AllFlagsOptions): Promise<PostHogFlagSnapshot>;
};

export async function evaluatePostHogFlags(params: {
	client: Pick<PostHog, 'evaluateFlags'> | EvaluateFlagsClient | null;
	distinctId: string;
	groups?: AllFlagsOptions['groups'];
	personProperties?: AllFlagsOptions['personProperties'];
	timeoutMs?: number;
}): Promise<PostHogFlagSnapshot | null> {
	const distinctId = params.distinctId.trim();
	if (!params.client || !distinctId) {
		return null;
	}

	try {
		return await withTimeout(
			params.client.evaluateFlags(distinctId, {
				groups: params.groups,
				personProperties: params.personProperties,
			}),
			params.timeoutMs ?? FLAG_EVALUATION_TIMEOUT_MS
		);
	} catch {
		return null;
	}
}

export function flagValue(flags: PostHogFlagSnapshot | null, key: string): boolean | string | undefined {
	if (!flags) return undefined;
	const value = flags.getFlag(key);
	if (typeof value === 'boolean' || typeof value === 'string') return value;
	return undefined;
}

export function isPostHogFlagEnabled(flags: PostHogFlagSnapshot | null, key: string): boolean {
	return flags?.isEnabled(key) === true;
}

export function flagsForClient(flags: PostHogFlagSnapshot | null): Record<string, boolean | string> {
	if (!flags) return {};
	const out: Record<string, boolean | string> = {};
	for (const key of flags.keys) {
		const value = flagValue(flags, key);
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Build a snapshot from a flat flag map (used for dev overrides). */
export function snapshotFromFlagMap(values: Record<string, boolean | string>): PostHogFlagSnapshot {
	return {
		keys: Object.keys(values),
		isEnabled: (key) => values[key] === true,
		getFlag: (key) => values[key],
	};
}

/**
 * Parse `FEATURE_FLAG_OVERRIDES` JSON (`{"closet-browse":true,"copy-test":"control"}`).
 * Invalid JSON / non-object → empty map.
 */
export function parseFeatureFlagOverrides(raw: string | undefined): Record<string, boolean | string> {
	if (!raw?.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const out: Record<string, boolean | string> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			const trimmed = key.trim();
			if (!trimmed) continue;
			if (typeof value === 'boolean' || typeof value === 'string') {
				out[trimmed] = value;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Dev-only: merge `FEATURE_FLAG_OVERRIDES` over PostHog evaluation.
 * Staging/production ignore overrides even if the env var is set.
 */
export function resolveFeatureFlagSnapshot(params: {
	flags: PostHogFlagSnapshot | null;
	envName: Env['ENV_NAME'] | string | undefined;
	overridesRaw?: string;
}): PostHogFlagSnapshot | null {
	if (params.envName !== 'dev') return params.flags;

	const overrides = parseFeatureFlagOverrides(params.overridesRaw);
	if (Object.keys(overrides).length === 0) return params.flags;

	return snapshotFromFlagMap({ ...flagsForClient(params.flags), ...overrides });
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('posthog_flag_eval_timeout')), timeoutMs);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}
