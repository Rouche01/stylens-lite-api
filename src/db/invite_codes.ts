import type { InviteCode } from './types';

export type CreateInviteCodeParams = {
	code: string;
	trialDays?: number | null;
	trialSessionLimit?: number | null;
	monthlySessionLimit?: number | null;
	messagePerSessionLimit?: number | null;
	imagePerSessionLimit?: number | null;
	maxRedemptions?: number | null;
	expiresAt?: number | null;
};

export class InviteCodesDB {
	constructor(private db: D1Database) {}

	normalizeCode(code: string): string {
		return code.trim().toUpperCase();
	}

	async getByCode(code: string): Promise<InviteCode | null> {
		const normalized = this.normalizeCode(code);
		const result = await this.db
			.prepare(`SELECT * FROM invite_codes WHERE code = ?`)
			.bind(normalized)
			.first<InviteCode>();
		return result || null;
	}

	async listInviteCodes(): Promise<InviteCode[]> {
		const result = await this.db
			.prepare(`SELECT * FROM invite_codes ORDER BY created_at DESC`)
			.all<InviteCode>();
		return result.results || [];
	}

	async createInviteCode(params: CreateInviteCodeParams): Promise<InviteCode> {
		const now = Date.now();
		const id = crypto.randomUUID();
		const code = this.normalizeCode(params.code);

		if (!code) {
			throw new Error('Invite code is required');
		}

		await this.db
			.prepare(
				`INSERT INTO invite_codes (
					id, code, trial_days, trial_session_limit, monthly_session_limit,
					message_per_session_limit, image_per_session_limit,
					max_redemptions, redemption_count, expires_at, is_active, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`
			)
			.bind(
				id,
				code,
				params.trialDays ?? null,
				params.trialSessionLimit ?? null,
				params.monthlySessionLimit ?? null,
				params.messagePerSessionLimit ?? null,
				params.imagePerSessionLimit ?? null,
				params.maxRedemptions ?? null,
				params.expiresAt ?? null,
				now,
				now
			)
			.run();

		const created = await this.getByCode(code);
		return created!;
	}

	/**
	 * Returns a redeemable invite code or throws a user-facing error message.
	 */
	async getRedeemableCode(code: string, now: number = Date.now()): Promise<InviteCode> {
		const invite = await this.getByCode(code);
		if (!invite || !invite.is_active) {
			throw new Error('Invalid invite code');
		}
		if (invite.expires_at !== null && invite.expires_at <= now) {
			throw new Error('Invite code has expired');
		}
		if (invite.max_redemptions !== null && invite.redemption_count >= invite.max_redemptions) {
			throw new Error('Invite code has reached its redemption limit');
		}
		return invite;
	}

	incrementRedemptionStatement(inviteId: string, now: number = Date.now()): D1PreparedStatement {
		return this.db
			.prepare(
				`UPDATE invite_codes
				 SET redemption_count = redemption_count + 1, updated_at = ?
				 WHERE id = ?
				   AND is_active = 1
				   AND (expires_at IS NULL OR expires_at > ?)
				   AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`
			)
			.bind(now, inviteId, now);
	}
}
