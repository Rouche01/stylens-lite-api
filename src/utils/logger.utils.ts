export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContextValue = string | number | boolean | null | undefined;

export type LogContext = Record<string, LogContextValue>;

export type LogSink = {
	emitLog(level: LogLevel, message: string, attributes: LogContext): void;
	captureException(err: unknown, distinctId: string, properties: Record<string, unknown>): void;
	flush(ctx: ExecutionContext): void;
};

export type Logger = {
	debug(message: string, context?: LogContext): void;
	info(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext, err?: unknown): void;
	error(message: string, context?: LogContext, err?: unknown): void;
	child(context: LogContext): Logger;
};

export type LoggerOptions = {
	env: Env['ENV_NAME'];
	context?: LogContext;
	sink?: LogSink | null;
};

export function maskToken(token: string): string {
	if (token.length <= 12) return '***';
	return `${token.slice(0, 8)}...${token.slice(-4)} (${token.length} chars)`;
}

export function serializeError(err: unknown): LogContext {
	if (err instanceof Error) {
		return {
			error_name: err.name,
			error_message: err.message,
		};
	}

	return {
		error_message: String(err),
	};
}

export function distinctIdFromLogContext(context: LogContext): string {
	const id = context.auth_id ?? context.user_id;
	return typeof id === 'string' && id.length > 0 ? id : 'anonymous';
}

function shouldExportToPostHog(level: LogLevel, message: string): boolean {
	return level === 'warn' || level === 'error' || (level === 'info' && message === 'request_completed');
}

function emit(
	level: LogLevel,
	env: Env['ENV_NAME'],
	baseContext: LogContext,
	sink: LogSink | null | undefined,
	message: string,
	context?: LogContext,
	err?: unknown
): void {
	if (level === 'debug' && env === 'production') {
		return;
	}

	const payload: Record<string, LogContextValue> = {
		level,
		message,
		env,
		...baseContext,
		...context,
	};

	if (err !== undefined) {
		Object.assign(payload, serializeError(err));
	}

	switch (level) {
		case 'warn':
			console.warn(payload);
			break;
		case 'error':
			console.error(payload);
			break;
		default:
			console.log(payload);
	}

	if (!sink || !shouldExportToPostHog(level, message)) {
		return;
	}

	try {
		const distinctId = distinctIdFromLogContext(payload);
		const attributes: LogContext = {
			...payload,
			posthogDistinctId: distinctId,
			'service.name': 'stylens-lite-api',
		};

		sink.emitLog(level, message, attributes);

		if (level === 'error' && err instanceof Error) {
			sink.captureException(err, distinctId, {
				...payload,
				service: 'stylens-lite-api',
			});
		}
	} catch (sinkErr) {
		console.warn({
			level: 'warn',
			message: 'posthog_logger_sink_failed',
			error_message: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
		});
	}
}

export function createLogger(options: LoggerOptions): Logger {
	const baseContext = options.context ?? {};
	const sink = options.sink;

	const logger: Logger = {
		debug(message, context) {
			emit('debug', options.env, baseContext, sink, message, context);
		},
		info(message, context) {
			emit('info', options.env, baseContext, sink, message, context);
		},
		warn(message, context, err) {
			emit('warn', options.env, baseContext, sink, message, context, err);
		},
		error(message, context, err) {
			emit('error', options.env, baseContext, sink, message, context, err);
		},
		child(context) {
			return createLogger({
				env: options.env,
				sink,
				context: { ...baseContext, ...context },
			});
		},
	};

	return logger;
}
