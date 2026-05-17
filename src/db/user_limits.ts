import { UserLimit } from './types';

export class UserLimitsDB {
	constructor(private db: D1Database) { }

	async getUserLimit(userId: string): Promise<UserLimit | null> {
		const result = await this.db
			.prepare(`SELECT * FROM user_limits WHERE user_id = ?`)
			.bind(userId)
			.first<UserLimit>();
		return result || null;
	}

	async updateUserLimit(userId: string, limits: Partial<Pick<UserLimit, 'session_count_limit' | 'message_per_session_limit' | 'image_per_session_limit'>>): Promise<UserLimit> {
		const now = Date.now();
		const existing = await this.getUserLimit(userId);

		if (existing) {
			const fields = [];
			const values = [];

			if (limits.session_count_limit !== undefined) {
				fields.push('session_count_limit = ?');
				values.push(limits.session_count_limit);
			}
			if (limits.message_per_session_limit !== undefined) {
				fields.push('message_per_session_limit = ?');
				values.push(limits.message_per_session_limit);
			}
			if (limits.image_per_session_limit !== undefined) {
				fields.push('image_per_session_limit = ?');
				values.push(limits.image_per_session_limit);
			}

			if (fields.length > 0) {
				fields.push('updated_at = ?');
				values.push(now);
				values.push(userId);

				await this.db
					.prepare(`UPDATE user_limits SET ${fields.join(', ')} WHERE user_id = ?`)
					.bind(...values)
					.run();
			}
		} else {
			const id = crypto.randomUUID();
			await this.db
				.prepare(
					`INSERT INTO user_limits (id, user_id, session_count_limit, message_per_session_limit, image_per_session_limit, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					id,
					userId,
					limits.session_count_limit ?? null,
					limits.message_per_session_limit ?? null,
					limits.image_per_session_limit ?? null,
					now,
					now
				)
				.run();
		}

		return (await this.getUserLimit(userId))!;
	}

	async deleteUserLimit(userId: string): Promise<void> {
		await this.db.prepare(`DELETE FROM user_limits WHERE user_id = ?`).bind(userId).run();
	}
}
