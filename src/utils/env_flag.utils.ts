/** Truthy string flags from Wrangler / .dev.vars (`"true"`, `"1"`, `"yes"`). */
export function isEnvFlagEnabled(value: string | undefined | null): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === 'true' || v === '1' || v === 'yes';
}
