export type DailyStyleNudgeCandidate = {
	user_id: string;
	/** Resolved IANA zone (UTC when users.timezone is null). */
	timezone: string;
	last_notified_at: number | null;
	ignore_streak: number;
	effective_ignore_streak: number;
	latest_session_at: number | null;
};

export const DAILY_STYLE_NUDGE_IGNORE_STREAK_CAP = 3;
export const DAILY_STYLE_NUDGE_BATCH_LIMIT = 100;

/**
 * Streak resets when the user completed a style session after the last nudge
 * (or when they have never been nudged).
 */
export function effectiveIgnoreStreak(params: {
	storedStreak: number;
	lastNotifiedAt: number | null;
	latestSessionAt: number | null;
}): number {
	if (params.lastNotifiedAt == null) return 0;
	if (params.latestSessionAt != null && params.latestSessionAt > params.lastNotifiedAt) {
		return 0;
	}
	return Math.max(0, Math.floor(params.storedStreak));
}

export class DailyStyleNudgeDB {
	constructor(private db: D1Database) {}

	/**
	 * Candidates for a single calendar day bucket (`dayStartMs` = local midnight).
	 * Morning-hour filtering and per-timezone bucketing belong in the cron job.
	 *
	 * Optional `timezone` filters to one IANA zone (use `UTC` for null/blank users.timezone).
	 */
	async listCandidates(params: {
		dayStartMs: number;
		timezone?: string;
		ignoreStreakCap?: number;
		limit?: number;
	}): Promise<DailyStyleNudgeCandidate[]> {
		const dayStartMs = params.dayStartMs;
		const ignoreStreakCap = params.ignoreStreakCap ?? DAILY_STYLE_NUDGE_IGNORE_STREAK_CAP;
		const limit = params.limit ?? DAILY_STYLE_NUDGE_BATCH_LIMIT;
		const timezoneFilter = params.timezone?.trim() || null;

		const timezoneSelect = `COALESCE(NULLIF(TRIM(u.timezone), ''), 'UTC')`;
		const timezoneClause =
			timezoneFilter == null
				? ''
				: timezoneFilter === 'UTC'
					? ` AND (${timezoneSelect} = 'UTC')`
					: ` AND (${timezoneSelect} = ?)`;

		const binds: (string | number)[] = [dayStartMs, dayStartMs, dayStartMs, ignoreStreakCap];
		if (timezoneFilter != null && timezoneFilter !== 'UTC') {
			binds.push(timezoneFilter);
		}
		binds.push(limit);

		const result = await this.db
			.prepare(
				`SELECT
					u.id AS user_id,
					${timezoneSelect} AS timezone,
					n.last_notified_at AS last_notified_at,
					COALESCE(n.ignore_streak, 0) AS ignore_streak,
					CASE
						WHEN n.last_notified_at IS NULL THEN 0
						WHEN EXISTS (
							SELECT 1
							FROM style_analysis_histories h_sess
							WHERE h_sess.user_id = u.id
							  AND IFNULL(h_sess.is_deleted, 0) = 0
							  AND h_sess.created_at > n.last_notified_at
						) THEN 0
						ELSE COALESCE(n.ignore_streak, 0)
					END AS effective_ignore_streak,
					(
						SELECT MAX(h_latest.created_at)
						FROM style_analysis_histories h_latest
						WHERE h_latest.user_id = u.id
						  AND IFNULL(h_latest.is_deleted, 0) = 0
					) AS latest_session_at
				 FROM users u
				 LEFT JOIN daily_style_nudge_state n ON n.user_id = u.id
				 WHERE u.is_active = 1
				   AND EXISTS (
				     SELECT 1 FROM push_tokens pt WHERE pt.user_id = u.id
				   )
				   AND EXISTS (
				     SELECT 1
				     FROM style_analysis_histories h_any
				     WHERE h_any.user_id = u.id
				       AND IFNULL(h_any.is_deleted, 0) = 0
				   )
				   AND (
				     SELECT MIN(h_first.created_at)
				     FROM style_analysis_histories h_first
				     WHERE h_first.user_id = u.id
				       AND IFNULL(h_first.is_deleted, 0) = 0
				   ) < ?
				   AND NOT EXISTS (
				     SELECT 1
				     FROM style_analysis_histories h_today
				     WHERE h_today.user_id = u.id
				       AND IFNULL(h_today.is_deleted, 0) = 0
				       AND h_today.created_at >= ?
				   )
				   AND (n.last_notified_at IS NULL OR n.last_notified_at < ?)
				   AND (
				     CASE
				       WHEN n.last_notified_at IS NULL THEN 0
				       WHEN EXISTS (
				         SELECT 1
				         FROM style_analysis_histories h_reset
				         WHERE h_reset.user_id = u.id
				           AND IFNULL(h_reset.is_deleted, 0) = 0
				           AND h_reset.created_at > n.last_notified_at
				       ) THEN 0
				       ELSE COALESCE(n.ignore_streak, 0)
				     END
				   ) < ?
				   ${timezoneClause}
				 ORDER BY u.id ASC
				 LIMIT ?`
			)
			.bind(...binds)
			.all<{
				user_id: string;
				timezone: string;
				last_notified_at: number | null;
				ignore_streak: number;
				effective_ignore_streak: number;
				latest_session_at: number | null;
			}>();

		return (result.results ?? []).map((row) => ({
			user_id: row.user_id,
			timezone: row.timezone || 'UTC',
			last_notified_at: row.last_notified_at ?? null,
			ignore_streak: row.ignore_streak ?? 0,
			effective_ignore_streak: row.effective_ignore_streak ?? 0,
			latest_session_at: row.latest_session_at ?? null,
		}));
	}

	async getState(
		userId: string
	): Promise<{ last_notified_at: number; ignore_streak: number; updated_at: number } | null> {
		const row = await this.db
			.prepare(
				`SELECT last_notified_at, ignore_streak, updated_at
				 FROM daily_style_nudge_state
				 WHERE user_id = ?`
			)
			.bind(userId)
			.first<{ last_notified_at: number; ignore_streak: number; updated_at: number }>();
		return row ?? null;
	}

	/**
	 * After a successful send: persist `last_notified_at` and the next streak
	 * (`effective_ignore_streak + 1` from the candidate row).
	 */
	async markNotified(params: {
		userId: string;
		atMs: number;
		ignoreStreak: number;
	}): Promise<void> {
		const ignoreStreak = Math.max(0, Math.floor(params.ignoreStreak));
		await this.db
			.prepare(
				`INSERT INTO daily_style_nudge_state
				   (user_id, last_notified_at, ignore_streak, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(user_id) DO UPDATE SET
				   last_notified_at = excluded.last_notified_at,
				   ignore_streak = excluded.ignore_streak,
				   updated_at = excluded.updated_at`
			)
			.bind(params.userId, params.atMs, ignoreStreak, params.atMs)
			.run();
	}
}

export const createDailyStyleNudgeDB = (db: D1Database) => new DailyStyleNudgeDB(db);
