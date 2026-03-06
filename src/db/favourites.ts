import { StyleAnalysisHistory } from './types';

export class FavouritesDB {
	constructor(private db: D1Database) { }

	async addHistoryFavourite(userId: string, historyId: string): Promise<void> {
		const now = Date.now();
		const favouriteId = crypto.randomUUID();

		await this.db
			.prepare(
				`
        INSERT OR IGNORE INTO favourites (id, user_id, style_analysis_history_id, created_at)
        VALUES (?, ?, ?, ?)
        `
			)
			.bind(favouriteId, userId, historyId, now)
			.run();
	}

	async removeHistoryFavourite(userId: string, historyId: string): Promise<void> {
		await this.db
			.prepare(
				`
				DELETE FROM favourites
				WHERE user_id = ? AND style_analysis_history_id = ?
				`
			)
			.bind(userId, historyId)
			.run();
	}

	async getHistoryFavourites(userId: string): Promise<StyleAnalysisHistory[]> {
		const result = await this.db
			.prepare(
				`
				SELECT h.*
				FROM style_analysis_histories h
				JOIN favourites f ON h.id = f.style_analysis_history_id
				WHERE f.user_id = ? AND h.is_deleted = 0
				ORDER BY f.created_at DESC
				`
			)
			.bind(userId)
			.all<StyleAnalysisHistory>();

		return result.results || [];
	}
}
