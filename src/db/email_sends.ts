import { EmailSendStatus } from '../services/email/types';

export type EmailSend = {
	id: string;
	user_id: string;
	template_key: string;
	campaign_key: string | null;
	provider: string;
	provider_message_id: string | null;
	status: EmailSendStatus;
	sent_at: number | null;
	opened_at: number | null;
	clicked_at: number | null;
	created_at: number;
	updated_at: number;
};

export class EmailSendsDB {
	constructor(private db: D1Database) {}

	async hasSent(
		userId: string,
		templateKey: string,
		campaignKey: string | null
	): Promise<boolean> {
		const row = campaignKey
			? await this.db
					.prepare(
						`SELECT id FROM email_sends
						 WHERE user_id = ?
						   AND template_key = ?
						   AND campaign_key = ?
						   AND status IN ('queued', 'sent')
						 LIMIT 1`
					)
					.bind(userId, templateKey, campaignKey)
					.first()
			: await this.db
					.prepare(
						`SELECT id FROM email_sends
						 WHERE user_id = ?
						   AND template_key = ?
						   AND campaign_key IS NULL
						   AND status IN ('queued', 'sent')
						 LIMIT 1`
					)
					.bind(userId, templateKey)
					.first();

		return !!row;
	}

	async createQueued(params: {
		userId: string;
		templateKey: string;
		campaignKey?: string | null;
		provider: string;
	}): Promise<EmailSend> {
		const now = Date.now();
		const id = crypto.randomUUID();
		await this.db
			.prepare(
				`INSERT INTO email_sends (
					id, user_id, template_key, campaign_key, provider, provider_message_id,
					status, sent_at, opened_at, clicked_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, NULL, 'queued', NULL, NULL, NULL, ?, ?)`
			)
			.bind(
				id,
				params.userId,
				params.templateKey,
				params.campaignKey ?? null,
				params.provider,
				now,
				now
			)
			.run();

		const row = await this.getById(id);
		if (!row) throw new Error('Failed to create email_sends row');
		return row;
	}

	async markSent(id: string, providerMessageId: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE email_sends
				 SET status = 'sent',
				     provider_message_id = ?,
				     sent_at = ?,
				     updated_at = ?
				 WHERE id = ?`
			)
			.bind(providerMessageId, now, now, id)
			.run();
	}

	async markFailed(id: string): Promise<void> {
		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE email_sends
				 SET status = 'failed',
				     updated_at = ?
				 WHERE id = ?`
			)
			.bind(now, id)
			.run();
	}

	async getById(id: string): Promise<EmailSend | null> {
		return (
			(await this.db
				.prepare(`SELECT * FROM email_sends WHERE id = ?`)
				.bind(id)
				.first<EmailSend>()) ?? null
		);
	}

	async getByProviderMessageId(providerMessageId: string): Promise<EmailSend | null> {
		return (
			(await this.db
				.prepare(`SELECT * FROM email_sends WHERE provider_message_id = ?`)
				.bind(providerMessageId)
				.first<EmailSend>()) ?? null
		);
	}

	/**
	 * Apply ESP webhook. Terminal statuses (bounced/complained/failed) win over sent.
	 * Opens/clicks set timestamps without demoting terminal statuses.
	 */
	async applyWebhookEvent(event: {
		providerMessageId: string;
		status: EmailSendStatus;
		openedAt?: number;
		clickedAt?: number;
	}): Promise<EmailSend | null> {
		const existing = await this.getByProviderMessageId(event.providerMessageId);
		if (!existing) return null;

		const terminal: EmailSendStatus[] = ['bounced', 'complained', 'failed'];
		const isTerminal = terminal.includes(existing.status);

		let nextStatus = existing.status;
		if (event.openedAt !== undefined || event.clickedAt !== undefined) {
			// engagement: keep existing status unless still queued
			if (existing.status === 'queued') nextStatus = 'sent';
		} else if (!isTerminal || terminal.includes(event.status)) {
			nextStatus = event.status;
		}

		const openedAt =
			event.openedAt !== undefined
				? existing.opened_at ?? event.openedAt
				: existing.opened_at;
		const clickedAt =
			event.clickedAt !== undefined
				? existing.clicked_at ?? event.clickedAt
				: existing.clicked_at;

		const now = Date.now();
		await this.db
			.prepare(
				`UPDATE email_sends
				 SET status = ?,
				     opened_at = ?,
				     clicked_at = ?,
				     updated_at = ?
				 WHERE provider_message_id = ?`
			)
			.bind(nextStatus, openedAt, clickedAt, now, event.providerMessageId)
			.run();

		return this.getByProviderMessageId(event.providerMessageId);
	}

	async updateByProviderMessageId(
		providerMessageId: string,
		updates: Partial<Pick<EmailSend, 'status' | 'opened_at' | 'clicked_at'>>
	): Promise<void> {
		const fields: string[] = [];
		const values: Array<string | number | null> = [];

		if (updates.status !== undefined) {
			fields.push('status = ?');
			values.push(updates.status);
		}
		if (updates.opened_at !== undefined) {
			fields.push('opened_at = ?');
			values.push(updates.opened_at);
		}
		if (updates.clicked_at !== undefined) {
			fields.push('clicked_at = ?');
			values.push(updates.clicked_at);
		}
		if (fields.length === 0) return;

		fields.push('updated_at = ?');
		values.push(Date.now());
		values.push(providerMessageId);

		await this.db
			.prepare(`UPDATE email_sends SET ${fields.join(', ')} WHERE provider_message_id = ?`)
			.bind(...values)
			.run();
	}
}
