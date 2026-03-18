import { error } from 'itty-router';

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
