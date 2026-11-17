import type { PushToken } from './types';

export class PushTokensDB {
	constructor(private db: D1Database) {}

	async upsertToken(params: {
		userId: string;
		token: string;
		platform: 'ios' | 'android';
	}): Promise<void> {
		const { userId, token, platform } = params;
		const now = Date.now();
		const id = crypto.randomUUID();

		await this.db
			.prepare(
				`
				INSERT INTO push_tokens (id, user_id, token, platform, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(token) DO UPDATE SET
					user_id = EXCLUDED.user_id,
					updated_at = EXCLUDED.updated_at
				`
			)
			.bind(id, userId, token, platform, now, now)
			.run();
	}

	async deleteToken(token: string, userId: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM push_tokens WHERE token = ? AND user_id = ?`)
			.bind(token, userId)
			.run();
	}

	async getTokensByUserId(userId: string): Promise<PushToken[]> {
		const result = await this.db
			.prepare(`SELECT * FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC`)
			.bind(userId)
			.all<PushToken>();

		return result.results || [];
	}
}
