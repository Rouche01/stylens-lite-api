import { error } from 'itty-router';
import type { LogContext, Logger } from 'utils/logger.utils';

const EXPECTED_CLIENT_ERROR_MARKERS = ['FREE_LIMIT_REACHED', 'NOT_FOUND', 'IMAGE_UPLOAD_TIMEOUT'];

export function isExpectedClientError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}

	if (err.name === 'ImageUploadTimeoutError') {
		return true;
	}

	return EXPECTED_CLIENT_ERROR_MARKERS.some((marker) => err.message.includes(marker));
}

export function logRouteError(log: Logger, message: string, err: unknown, context?: LogContext): void {
	if (isExpectedClientError(err)) {
		log.warn(message, context, err);
		return;
	}

	log.error(message, context, err);
}

/**
 * Returns a JSON error response with a machine-readable code.
 * All codes are automatically prefixed with 'STYLENS_' for namespacing.
 * 
 * @param status HTTP status code
 * @param message Human-readable error message
 * @param code Machine-readable error code (without namespace)
 */
export const apiError = (status: number, message: string, code?: string) => {
    const errorResponse = error(status, message);
    
    // itty-router's error() returns a Response with a JSON body
    // we want to augment that body with the code
    if (code) {
        const namespace = 'STYLENS_';
        const prefixedCode = code.startsWith(namespace) ? code : `${namespace}${code}`;
        
        return new Response(JSON.stringify({
            status,
            error: message,
            code: prefixedCode
        }), {
            status,
            headers: {
                'Content-Type': 'application/json'
            }
        });
    }

    return errorResponse;
};
