/**
 * Performs a timing-safe comparison between two strings.
 * This is used to prevent timing attacks when comparing sensitive values like API keys or webhook secrets.
 */
export function verifyTimingSafe(provided: string, expected: string): boolean {
    const encoder = new TextEncoder();
    const a = encoder.encode(provided);
    const b = encoder.encode(expected);

    if (a.byteLength !== b.byteLength) {
        return false;
    }

    return crypto.subtle.timingSafeEqual(a, b);
}
