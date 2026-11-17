export type ActivationD0Candidate = {
	user_id: string;
	email: string;
	name: string;
	created_at: number;
};

/** Users signed up at least this long ago before activation_d0 (12h). */
export const ACTIVATION_D0_MIN_AGE_MS = 12 * 60 * 60 * 1000;

export const ACTIVATION_D0_BATCH_LIMIT = 50;

/**
 * Opted-in users with email, past the signup wait window, no assistant tip yet,
 * and no prior activation_d0 send (queued/sent).
 */
export class EmailSegmentsDB {
	constructor(private db: D1Database) {}

	async listActivationD0Candidates(params?: {
		nowMs?: number;
		minAgeMs?: number;
		limit?: number;
	}): Promise<ActivationD0Candidate[]> {
		const nowMs = params?.nowMs ?? Date.now();
		const minAgeMs = params?.minAgeMs ?? ACTIVATION_D0_MIN_AGE_MS;
		const limit = params?.limit ?? ACTIVATION_D0_BATCH_LIMIT;
		const createdBefore = nowMs - minAgeMs;

		const result = await this.db
			.prepare(
				`SELECT u.id AS user_id, u.email, u.name, u.created_at
				 FROM users u
				 INNER JOIN user_email_prefs p ON p.user_id = u.id
				 WHERE u.is_active = 1
				   AND u.email IS NOT NULL
				   AND length(trim(u.email)) > 0
				   AND p.marketing_opt_in = 1
				   AND p.marketing_unsubscribed_at IS NULL
				   AND u.created_at <= ?
				   AND NOT EXISTS (
				     SELECT 1
				     FROM style_analysis_histories h
				     INNER JOIN style_analysis_entries e
				       ON e.style_analysis_history_id = h.id
				     WHERE h.user_id = u.id
				       AND IFNULL(h.is_deleted, 0) = 0
				       AND e.role = 'assistant'
				   )
				   AND NOT EXISTS (
				     SELECT 1
				     FROM email_sends s
				     WHERE s.user_id = u.id
				       AND s.template_key = 'activation_d0'
				       AND s.campaign_key IS NULL
				       AND s.status IN ('queued', 'sent')
				   )
				 ORDER BY u.created_at ASC
				 LIMIT ?`
			)
			.bind(createdBefore, limit)
			.all<ActivationD0Candidate>();

		return result.results ?? [];
	}
}

export const createEmailSegmentsDB = (db: D1Database) => new EmailSegmentsDB(db);
