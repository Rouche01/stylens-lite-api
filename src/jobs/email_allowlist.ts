/**
 * Pure helpers for lifecycle email cron (allowlist + base URL).
 */

/** Comma-separated emails → lowercase set. Empty / missing → empty set. */
export function parseEmailAllowlist(raw: string | undefined | null): Set<string> {
	if (!raw?.trim()) return new Set();
	return new Set(
		raw
			.split(',')
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean)
	);
}

/**
 * Local/dev must set EMAIL_SEND_ALLOWLIST or the job sends nothing.
 * Staging and production with empty allowlist send to all eligible users.
 * When allowlist is set in any env, it still filters.
 */
export function shouldRestrictToAllowlist(envName: string): boolean {
	return envName !== 'production' && envName !== 'staging';
}

export function filterByAllowlist<T extends { email: string }>(
	candidates: T[],
	allowlist: Set<string>,
	restrict: boolean
): T[] {
	if (!restrict && allowlist.size === 0) return candidates;
	if (restrict && allowlist.size === 0) return [];
	return candidates.filter((c) => allowlist.has(c.email.trim().toLowerCase()));
}
