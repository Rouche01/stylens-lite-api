import type { UserAvatar } from './types';

function isUniqueConstraintError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /UNIQUE constraint failed/i.test(message) || /D1_ERROR.*UNIQUE/i.test(message);
}

export class AvatarsDB {
	constructor(private db: D1Database) {}

	async getById(id: string): Promise<UserAvatar | null> {
		const row = await this.db
			.prepare(`SELECT * FROM user_avatars WHERE id = ?`)
			.bind(id)
			.first<UserAvatar>();
		return row ?? null;
	}

	async getActiveAvatar(userId: string): Promise<UserAvatar | null> {
		const row = await this.db
			.prepare(
				`
				SELECT * FROM user_avatars
				WHERE user_id = ?
				  AND is_active = 1
				  AND status IN ('pending', 'ready')
				LIMIT 1
				`
			)
			.bind(userId)
			.first<UserAvatar>();
		return row ?? null;
	}

	async listByUser(userId: string): Promise<UserAvatar[]> {
		const result = await this.db
			.prepare(
				`
				SELECT * FROM user_avatars
				WHERE user_id = ?
				ORDER BY created_at DESC
				`
			)
			.bind(userId)
			.all<UserAvatar>();
		return result.results ?? [];
	}

	async insertRejectedFraming(params: {
		userId: string;
		sourceImageKey: string;
		sourceImageUrl?: string | null;
		framingConfidence?: string | null;
		error?: string | null;
	}): Promise<UserAvatar> {
		const id = crypto.randomUUID();
		const now = Date.now();

		await this.db
			.prepare(
				`
				INSERT INTO user_avatars (
					id, user_id, source_image_key, source_image_url, avatar_image_key,
					status, framing_confidence, model, error, is_active, created_at, updated_at
				) VALUES (?, ?, ?, ?, NULL, 'rejected_framing', ?, NULL, ?, 0, ?, ?)
				`
			)
			.bind(
				id,
				params.userId,
				params.sourceImageKey,
				params.sourceImageUrl ?? null,
				params.framingConfidence ?? null,
				params.error ?? null,
				now,
				now
			)
			.run();

		return {
			id,
			user_id: params.userId,
			source_image_key: params.sourceImageKey,
			source_image_url: params.sourceImageUrl ?? null,
			avatar_image_key: null,
			status: 'rejected_framing',
			framing_confidence: params.framingConfidence ?? null,
			model: null,
			error: params.error ?? null,
			is_active: 0,
			created_at: now,
			updated_at: now,
		};
	}

	/**
	 * Inserts a live pending row. Returns null when another pending/ready avatar
	 * already holds the one-in-flight unique index.
	 */
	async claimPending(params: {
		userId: string;
		sourceImageKey: string;
		sourceImageUrl?: string | null;
		framingConfidence?: string | null;
		model?: string | null;
	}): Promise<UserAvatar | null> {
		const id = crypto.randomUUID();
		const now = Date.now();

		try {
			await this.db
				.prepare(
					`
					INSERT INTO user_avatars (
						id, user_id, source_image_key, source_image_url, avatar_image_key,
						status, framing_confidence, model, error, is_active, created_at, updated_at
					) VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?, NULL, 1, ?, ?)
					`
				)
				.bind(
					id,
					params.userId,
					params.sourceImageKey,
					params.sourceImageUrl ?? null,
					params.framingConfidence ?? null,
					params.model ?? null,
					now,
					now
				)
				.run();
		} catch (err) {
			if (isUniqueConstraintError(err)) {
				return null;
			}
			throw err;
		}

		return {
			id,
			user_id: params.userId,
			source_image_key: params.sourceImageKey,
			source_image_url: params.sourceImageUrl ?? null,
			avatar_image_key: null,
			status: 'pending',
			framing_confidence: params.framingConfidence ?? null,
			model: params.model ?? null,
			error: null,
			is_active: 1,
			created_at: now,
			updated_at: now,
		};
	}

	async markReady(id: string, avatarImageKey: string, model?: string | null): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`
				UPDATE user_avatars
				SET status = 'ready',
				    avatar_image_key = ?,
				    model = COALESCE(?, model),
				    error = NULL,
				    is_active = 1,
				    updated_at = ?
				WHERE id = ?
				`
			)
			.bind(avatarImageKey, model ?? null, now, id)
			.run();
	}

	async markFailed(id: string, error: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`
				UPDATE user_avatars
				SET status = 'failed',
				    error = ?,
				    is_active = 0,
				    updated_at = ?
				WHERE id = ?
				`
			)
			.bind(error.slice(0, 1000), now, id)
			.run();
	}
}

export const createAvatarsDB = (db: D1Database) => new AvatarsDB(db);
