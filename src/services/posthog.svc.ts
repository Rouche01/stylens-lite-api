import { PostHog } from 'posthog-node';
import type { LogContext, LogContextValue, LogLevel, LogSink } from 'utils/logger.utils';
import {
	createKvFlagDefinitionCacheReader,
	createKvFlagDefinitionCacheWriter,
} from './flagDefinitionCache';

export const POSTHOG_SERVICE_NAME = 'stylens-lite-api';
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

type PostHogEnv = Pick<Env, 'POSTHOG_PROJECT_TOKEN' | 'POSTHOG_HOST' | 'ENV_NAME'>;

/** Project token plus optional local-evaluation secrets and KV. */
export type PostHogFlagEnv = PostHogEnv & {
	POSTHOG_PERSONAL_API_KEY?: string;
	FLAG_DEFINITIONS?: KVNamespace;
};

function isConfiguredToken(token: string | undefined): token is string {
	return Boolean(token && token !== 'dummy' && token.startsWith('phc_'));
}

/** Feature-flags secure API key (`phx_` personal or `phs_` project secret). */
function isConfiguredSecureKey(key: string | undefined): key is string {
	return Boolean(key && key !== 'dummy' && (key.startsWith('phx_') || key.startsWith('phs_')));
}

function otlpAttribute(key: string, value: LogContextValue): { key: string; value: Record<string, unknown> } | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value === 'number') {
		return { key, value: { doubleValue: value } };
	}
	if (typeof value === 'boolean') {
		return { key, value: { boolValue: value } };
	}
	return { key, value: { stringValue: String(value) } };
}

function severityText(level: LogLevel): string {
	return level.toUpperCase();
}

async function exportOtlpLog(params: {
	host: string;
	token: string;
	envName: Env['ENV_NAME'];
	level: LogLevel;
	message: string;
	attributes: LogContext;
}): Promise<void> {
	const { host, token, envName, level, message, attributes } = params;
	const logAttributes = Object.entries(attributes)
		.map(([key, value]) => otlpAttribute(key, value))
		.filter((attr): attr is NonNullable<typeof attr> => attr !== null);

	const body = {
		resourceLogs: [
			{
				resource: {
					attributes: [
						{ key: 'service.name', value: { stringValue: POSTHOG_SERVICE_NAME } },
						{ key: 'deployment.environment', value: { stringValue: envName } },
					],
				},
				scopeLogs: [
					{
						scope: { name: POSTHOG_SERVICE_NAME },
						logRecords: [
							{
								timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
								severityText: severityText(level),
								body: { stringValue: message },
								attributes: logAttributes,
							},
						],
					},
				],
			},
		],
	};

	const response = await fetch(`${host.replace(/\/$/, '')}/i/v1/logs`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		console.warn({
			level: 'warn',
			message: 'posthog_logs_export_failed',
			status: response.status,
		});
	}
}

export function createPostHogClient(env: PostHogEnv): PostHog | null {
	const token = env.POSTHOG_PROJECT_TOKEN;
	if (!isConfiguredToken(token)) {
		return null;
	}

	return new PostHog(token, {
		host: env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
		flushAt: 1,
		flushInterval: 0,
	});
}

/**
 * Client for flag evaluation. Uses KV + secure API key for local evaluation when both
 * are configured; otherwise falls back to remote `/flags` with the project token only.
 *
 * Pass `refreshDefinitions: true` from the scheduled handler so one writer refreshes KV.
 * Request paths use the default reader and never fetch definitions from PostHog.
 */
export function createPostHogFlagClient(
	env: PostHogFlagEnv,
	options?: { refreshDefinitions?: boolean }
): PostHog | null {
	const token = env.POSTHOG_PROJECT_TOKEN;
	if (!isConfiguredToken(token)) {
		return null;
	}

	const host = env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
	const secretKey = isConfiguredSecureKey(env.POSTHOG_PERSONAL_API_KEY)
		? env.POSTHOG_PERSONAL_API_KEY
		: undefined;
	const kv = env.FLAG_DEFINITIONS;

	if (secretKey && kv) {
		const refreshDefinitions = options?.refreshDefinitions === true;
		return new PostHog(token, {
			host,
			flushAt: 1,
			flushInterval: 0,
			secretKey,
			enableLocalEvaluation: true,
			// Reader: do not poll. Writer: short interval is unused once reloadFeatureFlags runs.
			featureFlagsPollingInterval: refreshDefinitions ? 30_000 : 24 * 60 * 60 * 1000,
			flagDefinitionCacheProvider: refreshDefinitions
				? createKvFlagDefinitionCacheWriter(kv)
				: createKvFlagDefinitionCacheReader(kv),
		});
	}

	return new PostHog(token, {
		host,
		flushAt: 1,
		flushInterval: 0,
	});
}

/** Cron: pull fresh definitions into KV when local evaluation is configured. */
export async function refreshPostHogFlagDefinitions(env: PostHogFlagEnv): Promise<boolean> {
	if (!isConfiguredSecureKey(env.POSTHOG_PERSONAL_API_KEY) || !env.FLAG_DEFINITIONS) {
		return false;
	}

	const client = createPostHogFlagClient(env, { refreshDefinitions: true });
	if (!client) return false;

	try {
		await client.reloadFeatureFlags();
		return true;
	} finally {
		await client.shutdown();
	}
}

export function createPostHogSink(env: PostHogEnv): LogSink | null {
	const posthog = createPostHogClient(env);
	if (!posthog || !isConfiguredToken(env.POSTHOG_PROJECT_TOKEN)) {
		return null;
	}

	const token = env.POSTHOG_PROJECT_TOKEN;
	const host = env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
	const pending: Promise<unknown>[] = [];

	const enqueue = (work: Promise<unknown>) => {
		pending.push(
			work.catch((err) => {
				console.warn({
					level: 'warn',
					message: 'posthog_sink_failed',
					error_message: err instanceof Error ? err.message : String(err),
				});
			})
		);
	};

	return {
		emitLog(level, message, attributes) {
			enqueue(
				exportOtlpLog({
					host,
					token,
					envName: env.ENV_NAME,
					level,
					message,
					attributes,
				})
			);
		},
		captureException(err, distinctId, properties) {
			enqueue(posthog.captureExceptionImmediate(err, distinctId, properties));
		},
		flush(ctx) {
			ctx.waitUntil(Promise.allSettled([...pending, posthog.shutdown()]));
		},
	};
}
