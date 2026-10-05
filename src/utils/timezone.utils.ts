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

export type ZonedDateTimeParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

/** Local calendar/clock parts for `ms` in `timeZone` (hour 0–23). */
export function getZonedParts(ms: number, timeZone: string): ZonedDateTimeParts {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	});
	const raw = Object.fromEntries(
		dtf
			.formatToParts(new Date(ms))
			.filter((p) => p.type !== 'literal')
			.map((p) => [p.type, p.value])
	) as Record<string, string>;
	return {
		year: Number(raw.year),
		month: Number(raw.month),
		day: Number(raw.day),
		hour: Number(raw.hour),
		minute: Number(raw.minute),
		second: Number(raw.second),
	};
}

/**
 * UTC ms for a wall-clock time in `timeZone` on a given local calendar date.
 * Two-pass offset correction handles most DST edges.
 */
export function zonedLocalToUtcMs(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string
): number {
	const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
	const p1 = getZonedParts(utcGuess, timeZone);
	const asIfLocalWasUtc = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second);
	let result = utcGuess - (asIfLocalWasUtc - utcGuess);

	const p2 = getZonedParts(result, timeZone);
	const asIf2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
	const target = Date.UTC(year, month - 1, day, hour, minute, second);
	return result + (target - asIf2);
}

/** UTC ms of local midnight for the calendar day containing `nowMs` in `timeZone`. */
export function localDayStartMs(nowMs: number, timeZone: string): number {
	const { year, month, day } = getZonedParts(nowMs, timeZone);
	return zonedLocalToUtcMs(year, month, day, 0, 0, 0, timeZone);
}

/** Inclusive local hours for the daily style nudge window (10:00–11:59). */
export const DAILY_STYLE_NUDGE_MORNING_HOUR_START = 10;
export const DAILY_STYLE_NUDGE_MORNING_HOUR_END = 11;

export function isLocalMorningWindow(
	nowMs: number,
	timeZone: string,
	hourStart = DAILY_STYLE_NUDGE_MORNING_HOUR_START,
	hourEnd = DAILY_STYLE_NUDGE_MORNING_HOUR_END
): boolean {
	const { hour } = getZonedParts(nowMs, timeZone);
	return hour >= hourStart && hour <= hourEnd;
}
