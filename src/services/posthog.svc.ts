import { PostHog } from 'posthog-node';
import type { LogContext, LogContextValue, LogLevel, LogSink } from 'utils/logger.utils';

export const POSTHOG_SERVICE_NAME = 'stylens-lite-api';
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

type PostHogEnv = Pick<Env, 'POSTHOG_PROJECT_TOKEN' | 'POSTHOG_HOST' | 'ENV_NAME'>;

function isConfiguredToken(token: string | undefined): token is string {
	return Boolean(token && token !== 'dummy' && token.startsWith('phc_'));
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

export function createPostHogSink(env: PostHogEnv): LogSink | null {
	if (!isConfiguredToken(env.POSTHOG_PROJECT_TOKEN)) {
		return null;
	}

	const token = env.POSTHOG_PROJECT_TOKEN;
	const host = env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
	const posthog = new PostHog(token, {
		host,
		flushAt: 1,
		flushInterval: 0,
	});
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
