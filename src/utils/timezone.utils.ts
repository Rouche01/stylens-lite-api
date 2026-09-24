export const DEFAULT_USER_TIMEZONE = 'UTC';

const MAX_TIMEZONE_LENGTH = 64;

/**
 * Returns true if `value` is a valid IANA time zone id (e.g. Europe/Amsterdam).
 */
export function isValidIanaTimeZone(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_TIMEZONE_LENGTH) return false;
	try {
		Intl.DateTimeFormat('en-US', { timeZone: trimmed });
		return true;
	} catch {
		return false;
	}
}

/**
 * Normalize an optional client timezone. Returns null when absent/blank.
 * Throws if a non-empty value is not a valid IANA id.
 */
export function parseOptionalTimeZone(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') {
		throw new Error('timezone must be a string');
	}
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (!isValidIanaTimeZone(trimmed)) {
		throw new Error('timezone must be a valid IANA time zone (e.g. Europe/Amsterdam)');
	}
	return trimmed;
}

/** Stored timezone or UTC when missing/invalid. */
export function resolveUserTimeZone(stored: string | null | undefined): string {
	if (stored == null) return DEFAULT_USER_TIMEZONE;
	const trimmed = stored.trim();
	if (!trimmed || !isValidIanaTimeZone(trimmed)) return DEFAULT_USER_TIMEZONE;
	return trimmed;
}
