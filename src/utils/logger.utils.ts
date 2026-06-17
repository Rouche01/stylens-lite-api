export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContextValue = string | number | boolean | null | undefined;

export type LogContext = Record<string, LogContextValue>;

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

function emit(
	level: LogLevel,
	env: Env['ENV_NAME'],
	baseContext: LogContext,
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
}

export function createLogger(options: LoggerOptions): Logger {
	const baseContext = options.context ?? {};

	const logger: Logger = {
		debug(message, context) {
			emit('debug', options.env, baseContext, message, context);
		},
		info(message, context) {
			emit('info', options.env, baseContext, message, context);
		},
		warn(message, context, err) {
			emit('warn', options.env, baseContext, message, context, err);
		},
		error(message, context, err) {
			emit('error', options.env, baseContext, message, context, err);
		},
		child(context) {
			return createLogger({
				env: options.env,
				context: { ...baseContext, ...context },
			});
		},
	};

	return logger;
}
