import { UserEmailPrefs } from './types';

export class UserEmailPrefsDB {
	constructor(private db: D1Database) {}

	async getByUserId(userId: string): Promise<UserEmailPrefs | null> {
		const result = await this.db
			.prepare(`SELECT * FROM user_email_prefs WHERE user_id = ?`)
			.bind(userId)
			.first<UserEmailPrefs>();
		return result ?? null;
	}

	/** True only when an explicit opt-in row exists and is not unsubscribed. */
	async isMarketingEligible(userId: string): Promise<boolean> {
		const prefs = await this.getByUserId(userId);
		if (!prefs) return false;
		return prefs.marketing_opt_in === 1 && prefs.marketing_unsubscribed_at == null;
	}

	/**
	 * Upsert marketing preference. Opt-in clears unsubscribe; opt-out sets unsubscribed_at.
	 * Missing row is created on first write (default remains opted out until opt-in).
	 */
	async updateMarketingOptIn(userId: string, marketingOptIn: boolean): Promise<UserEmailPrefs> {
		const now = Date.now();
		const existing = await this.getByUserId(userId);

		if (existing) {
			if (marketingOptIn) {
				await this.db
					.prepare(
						`UPDATE user_email_prefs
						 SET marketing_opt_in = 1,
						     marketing_opt_in_at = ?,
						     marketing_unsubscribed_at = NULL,
						     updated_at = ?
						 WHERE user_id = ?`
					)
					.bind(now, now, userId)
					.run();
			} else {
				await this.db
					.prepare(
						`UPDATE user_email_prefs
						 SET marketing_opt_in = 0,
						     marketing_unsubscribed_at = ?,
						     updated_at = ?
						 WHERE user_id = ?`
					)
					.bind(now, now, userId)
					.run();
			}
		} else {
			const id = crypto.randomUUID();
			await this.db
				.prepare(
					`INSERT INTO user_email_prefs (
						id, user_id, marketing_opt_in, marketing_opt_in_at, marketing_unsubscribed_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					userId,
					marketingOptIn ? 1 : 0,
					marketingOptIn ? now : null,
					marketingOptIn ? null : now,
					now,
					now
				)
				.run();
		}

		const prefs = await this.getByUserId(userId);
		if (!prefs) {
			throw new Error('Failed to persist user_email_prefs');
		}
		return prefs;
	}
}
