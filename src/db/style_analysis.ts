import type { StyleAnalysisHistory, StyleAnalysisEntry, CreateSessionParams, CreateSessionResult, AddMessageParams } from './types';

export class StyleAnalysisDB {
	constructor(private db: any) {}

	async createSessionWithInitialMessage(params: CreateSessionParams): Promise<CreateSessionResult> {
		const { userId, title, messages } = params;

		if (!userId) {
			throw new Error('userId is required');
		}

		if (!messages || messages.length === 0) {
			throw new Error('At least one message is required');
		}

		// Validate each message
		for (const message of messages) {
			if ((!message.remoteImage && !message.prompt) || !message.role) {
				throw new Error('Each message must have either image or prompt and a role');
			}
		}

		const sessionId = crypto.randomUUID();
		const now = Date.now();
		const sessionTitle = title || 'New Style Analysis';

		// Extract first image_url and image_key from messages for the session thumbnail
		const firstMessage = messages.find((m) => m.remoteImage);
		const firstMsgImageUrl = firstMessage?.remoteImage?.url || null;
		const firstMsgImageKey = firstMessage?.remoteImage?.key || null;

		// Create session
		await this.db
			.prepare(
				`
							INSERT INTO style_analysis_histories (id, user_id, title, image_url, image_key, created_at, updated_at)
							VALUES (?, ?, ?, ?, ?, ?, ?)
        `
			)
			.bind(sessionId, userId, sessionTitle, firstMsgImageUrl, firstMsgImageKey, now, now)
			.run();

		// Add all messages
		const messageIds: string[] = [];
		for (const message of messages) {
			const messageId = crypto.randomUUID();
			await this.db
				.prepare(
					`
                INSERT INTO style_analysis_entries (id, style_analysis_history_id, role, content, image_url, image_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `
				)
				.bind(
					messageId,
					sessionId,
					message.role,
					message.prompt || null,
					message.remoteImage?.url || null,
					message.remoteImage?.key || null,
					now
				)
				.run();

			messageIds.push(messageId);
		}

		return {
			sessionId,
			title: sessionTitle,
			messageIds,
		};
	}

	async addMessage(params: AddMessageParams): Promise<string> {
		const { sessionId, role, content, remoteImage } = params;

		if (!content && !remoteImage) {
			throw new Error('Either content or remoteImage is required');
		}

		const messageId = crypto.randomUUID();
		const now = Date.now();

		await this.db
			.prepare(
				`
            INSERT INTO style_analysis_entries (id, style_analysis_history_id, role, content, image_url, image_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `
			)
			.bind(messageId, sessionId, role, content || null, remoteImage?.url || null, remoteImage?.key || null, now)
			.run();

		// Update session timestamp if it's a user or assistant message
		if (role === 'user' || role === 'assistant') {
			await this.db
				.prepare(
					`
                UPDATE style_analysis_histories SET updated_at = ? WHERE id = ?
            `
				)
				.bind(now, sessionId)
				.run();
		}

		return messageId;
	}

	async getSession(sessionId: string, userId: string): Promise<StyleAnalysisHistory | null> {
		const result = await this.db
			.prepare(
				`
            SELECT * FROM style_analysis_histories WHERE id = ? AND user_id = ? AND is_deleted = 0
        `
			)
			.bind(sessionId, userId)
			.first();

		return result || null;
	}

	async getSessionMessages(sessionId: string): Promise<StyleAnalysisEntry[]> {
		const result = await this.db
			.prepare(
				`
            SELECT * FROM style_analysis_entries
            WHERE style_analysis_history_id = ?
            ORDER BY created_at ASC
        `
			)
			.bind(sessionId)
			.all();

		return result.results || [];
	}

	async getUserSessions(userId: string): Promise<StyleAnalysisHistory[]> {
		const result = await this.db
			.prepare(
				`
            SELECT h.* FROM style_analysis_histories h
            WHERE h.user_id = ?
						AND h.is_deleted = 0
            AND EXISTS (
                SELECT 1 FROM style_analysis_entries e
                WHERE e.style_analysis_history_id = h.id
            )
            ORDER BY h.updated_at DESC
        `
			)
			.bind(userId)
			.all();

		return result.results || [];
	}

	// Soft delete method
	async softDeleteSession(sessionId: string, userId: string): Promise<void> {
		const now = Date.now();
		const result = await this.db
			.prepare(
				`
            UPDATE style_analysis_histories
            SET is_deleted = 1, deleted_at = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND is_deleted = 0
            `
			)
			.bind(now, now, sessionId, userId)
			.run();

		if (result.changes === 0) {
			throw new Error('Session not found or already deleted');
		}
	}

	async hardDeleteSession(sessionId: string, userId: string): Promise<void> {
		const result = await this.db
			.prepare(
				`
            DELETE FROM style_analysis_histories
            WHERE id = ? AND user_id = ?
        `
			)
			.bind(sessionId, userId)
			.run();

		if (result.changes === 0) {
			throw new Error('Session not found');
		}
	}

	async sessionExists(sessionId: string, userId: string): Promise<boolean> {
		const result = await this.db
			.prepare(
				`
            SELECT 1 FROM style_analysis_histories WHERE id = ? AND user_id = ?
        `
			)
			.bind(sessionId, userId)
			.first();

		return !!result;
	}

	// Update session title (used for async title generation)
	async updateSessionTitle(sessionId: string, newTitle: string): Promise<void> {
		const now = Date.now();

		const result = await this.db
			.prepare(
				`
            UPDATE style_analysis_histories
            SET title = ?, updated_at = ?
            WHERE id = ?
        `
			)
			.bind(newTitle, now, sessionId)
			.run();

		// If nothing changed, throw so caller can log/handle if desired
		if (result.changes === 0) {
			throw new Error('Session not found or title unchanged');
		}
	}
}
