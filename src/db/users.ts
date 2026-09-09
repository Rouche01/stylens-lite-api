import { SubscriptionTier } from 'types';
import type { CreateUserParams, User } from './types';

export class UsersDB {
	private readonly userSelectQuery = `
			SELECT 
				u.*,
				s.id as s_id,
				s.tier as s_tier,
				s.provider as s_provider,
				s.provider_customer_id as s_provider_customer_id,
				s.provider_subscription_id as s_provider_subscription_id,
				s.status as s_status,
				s.current_period_end as s_current_period_end,
				s.has_reached_limit as s_has_reached_limit,
				s.created_at as s_created_at,
				s.updated_at as s_updated_at
			FROM users u
			LEFT JOIN subscriptions s ON u.id = s.user_id
		`;

	constructor(private db: D1Database) { }

	private mapUserRow(row: any): User {
		if (!row) return row;

		const user: User = {
			id: row.id,
			auth_id: row.auth_id,
			name: row.name,
			gender: row.gender,
			email: row.email,
			created_at: row.created_at,
			updated_at: row.updated_at,
			is_active: row.is_active,
		};

		if (row.s_id) {
			user.subscription = {
				id: row.s_id,
				user_id: row.id,
				tier: row.s_tier,
				provider: row.s_provider,
				provider_customer_id: row.s_provider_customer_id,
				provider_subscription_id: row.s_provider_subscription_id,
				status: row.s_status,
				current_period_end: row.s_current_period_end,
				has_reached_limit: row.s_has_reached_limit,
				created_at: row.s_created_at,
				updated_at: row.s_updated_at,
			};
		}

		return user;
	}

	async createUser(params: CreateUserParams): Promise<User> {
		const { authId, name, gender, email, inviteLimits, inviteRedemption } = params;
		const now = Date.now();
		const userId = crypto.randomUUID();
		const subscriptionId = crypto.randomUUID();

		const insertUserStmt = this.db
			.prepare(
				`
        INSERT INTO users (id, auth_id, name, gender, email, created_at, updated_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `
			)
			.bind(userId, authId, name, gender ?? null, email ?? null, now, now);

		const insertSubscriptionStmt = this.db
			.prepare(
				`
				INSERT INTO subscriptions (id, user_id, tier, provider, provider_customer_id, provider_subscription_id, status, current_period_end, has_reached_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
				`
			)
			.bind(subscriptionId, userId, SubscriptionTier.Free, null, null, null, 'active', null, now, now);

		const statements: D1PreparedStatement[] = [insertUserStmt, insertSubscriptionStmt];

		if (inviteLimits) {
			const limitId = crypto.randomUUID();
			statements.push(
				this.db
					.prepare(
						`INSERT INTO user_limits (
							id, user_id, session_count_limit, message_per_session_limit, image_per_session_limit,
							trial_days, trial_session_limit, monthly_session_limit, created_at, updated_at
						) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						limitId,
						userId,
						inviteLimits.message_per_session_limit ?? null,
						inviteLimits.image_per_session_limit ?? null,
						inviteLimits.trial_days ?? null,
						inviteLimits.trial_session_limit ?? null,
						inviteLimits.monthly_session_limit ?? null,
						now,
						now
					)
			);
		}

		if (inviteRedemption) {
			statements.push(
				this.db
					.prepare(
						`UPDATE invite_codes
						 SET redemption_count = redemption_count + 1, updated_at = ?
						 WHERE id = ?
						   AND is_active = 1
						   AND (expires_at IS NULL OR expires_at > ?)
						   AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`
					)
					.bind(now, inviteRedemption.inviteId, now)
			);
		}

		const batchResults = await this.db.batch(statements);

		if (inviteRedemption) {
			const redemptionResult = batchResults[batchResults.length - 1];
			if (!redemptionResult.success || (redemptionResult.meta?.changes ?? 0) === 0) {
				throw new Error('Invite code could not be redeemed');
			}
		}

		const user = await this.getUserById(userId);

		return user!;
	}

	async getUsers(): Promise<User[]> {
		const result = await this.db.prepare(this.userSelectQuery).all<any>();
		return (result.results || []).map((row) => this.mapUserRow(row));
	}

	async getUserById(id: string): Promise<User | null> {
		const result = await this.db.prepare(`${this.userSelectQuery} WHERE u.id = ?`).bind(id).first<any>();
		return result ? this.mapUserRow(result) : null;
	}

	async getUserByAuthId(authId: string): Promise<User | null> {
		const result = await this.db.prepare(`${this.userSelectQuery} WHERE u.auth_id = ?`).bind(authId).first<any>();
		return result ? this.mapUserRow(result) : null;
	}

	async updateUser(id: string, updates: Partial<Pick<User, 'name' | 'gender' | 'email' | 'is_active'>>): Promise<User | null> {
		const fields = [];
		const values = [];
		if (updates.name !== undefined) {
			fields.push('name = ?');
			values.push(updates.name);
		}
		if (updates.gender !== undefined) {
			fields.push('gender = ?');
			values.push(updates.gender);
		}
		if (updates.email !== undefined) {
			fields.push('email = ?');
			values.push(updates.email);
		}
		if (updates.is_active !== undefined) {
			fields.push('is_active = ?');
			values.push(updates.is_active);
		}
		if (fields.length === 0) return null;

		fields.push('updated_at = ?');
		values.push(Date.now());

		values.push(id);

		await this.db
			.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		const updatedUser = await this.getUserById(id);

		return updatedUser;
	}

	async deactivateUser(id: string): Promise<void> {
		await this.updateUser(id, { is_active: 0 });
	}

	async activateUser(id: string): Promise<void> {
		await this.updateUser(id, { is_active: 1 });
	}

	async deleteUser(id: string): Promise<void> {
		await this.db.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
	}
}
