import type { CreateUserParams, User } from './types';

export class UsersDB {
	constructor(private db: D1Database) {}

	async createUser(params: CreateUserParams): Promise<User> {
		const { authId, name, gender, email } = params;
		const now = Date.now();
		const userId = crypto.randomUUID();

		await this.db
			.prepare(
				`
        INSERT INTO users (id, auth_id, name, gender, email, created_at, updated_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `
			)
			.bind(userId, authId, name, gender ?? null, email ?? null, now, now)
			.run();

		const user = await this.getUserById(userId);

		return user!;
	}

	async getUserById(id: string): Promise<User | null> {
		const result = await this.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
		return result || null;
	}

	async getUserByAuthId(authId: string): Promise<User | null> {
		const result = await this.db.prepare(`SELECT * FROM users WHERE auth_id = ?`).bind(authId).first<User>();
		return result || null;
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
