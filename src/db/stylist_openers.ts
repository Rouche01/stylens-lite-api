import type {
	StylistOpenerMessage,
	StylistOpenerMessageRow,
	StylistOpenerMetaRow,
	StylistOpenersPayload,
	StylistOpenerTag,
} from './types';

function parseTags(tagsJson: string): StylistOpenerTag[] {
	const parsed = JSON.parse(tagsJson) as unknown;
	if (!Array.isArray(parsed)) {
		return [];
	}
	return parsed.filter(
		(tag): tag is StylistOpenerTag => tag === 'with_image' || tag === 'without_image'
	);
}

function rowToMessage(row: StylistOpenerMessageRow): StylistOpenerMessage {
	return {
		id: row.id,
		text: row.text,
		tags: parseTags(row.tags_json),
	};
}

export class StylistOpenersDB {
	constructor(private db: D1Database) {}

	async getVersion(): Promise<number> {
		const meta = await this.db
			.prepare(`SELECT version FROM stylist_opener_meta WHERE id = 1`)
			.first<Pick<StylistOpenerMetaRow, 'version'>>();
		return meta?.version ?? 0;
	}

	async getPool(): Promise<StylistOpenersPayload> {
		const [meta, messagesResult] = await Promise.all([
			this.db
				.prepare(`SELECT * FROM stylist_opener_meta WHERE id = 1`)
				.first<StylistOpenerMetaRow>(),
			this.db
				.prepare(
					`SELECT * FROM stylist_opener_messages ORDER BY created_at ASC, id ASC`
				)
				.all<StylistOpenerMessageRow>(),
		]);

		return {
			version: meta?.version ?? 0,
			messages: (messagesResult.results ?? []).map(rowToMessage),
		};
	}

	async replacePool(messages: StylistOpenerMessage[]): Promise<StylistOpenersPayload> {
		const now = Date.now();
		const currentVersion = await this.getVersion();
		const nextVersion = currentVersion + 1;

		const statements: D1PreparedStatement[] = [
			this.db.prepare(`DELETE FROM stylist_opener_messages`),
			this.db
				.prepare(
					`
					INSERT INTO stylist_opener_meta (id, version, updated_at)
					VALUES (1, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						version = excluded.version,
						updated_at = excluded.updated_at
					`
				)
				.bind(nextVersion, now),
		];

		for (const message of messages) {
			statements.push(
				this.db
					.prepare(
						`
						INSERT INTO stylist_opener_messages (id, text, tags_json, created_at)
						VALUES (?, ?, ?, ?)
						`
					)
					.bind(message.id, message.text, JSON.stringify(message.tags), now)
			);
		}

		await this.db.batch(statements);
		return {
			version: nextVersion,
			messages,
		};
	}
}
