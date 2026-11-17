import type {
	ClosetIdentityJobCounts,
	ClosetIdentityJobRow,
	ClosetIdentityJobStatus,
	ClosetIdentityProgressRow,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor = new (...args: any[]) => import('./base').ClosetDBBase;

export function WithClosetIdentityJobs<TBase extends Ctor>(Base: TBase) {
	return class extends Base {
		/**
		 * One create-commit writer per user. Stale rows (crashed workers) are stolen.
		 */
		async tryAcquireIdentityLock(userId: string, jobId: string, staleMs = 10 * 60 * 1000): Promise<boolean> {
			const now = Date.now();
			await this.db
				.prepare(`DELETE FROM identity_inflight WHERE user_id = ? AND created_at < ?`)
				.bind(userId, now - staleMs)
				.run();
			try {
				await this.db
					.prepare(
						`
						INSERT INTO identity_inflight (user_id, job_id, created_at)
						VALUES (?, ?, ?)
						`
					)
					.bind(userId, jobId, now)
					.run();
				return true;
			} catch {
				return false;
			}
		}

		async releaseIdentityLock(userId: string, jobId: string): Promise<void> {
			await this.db
				.prepare(`DELETE FROM identity_inflight WHERE user_id = ? AND job_id = ?`)
				.bind(userId, jobId)
				.run();
		}

		async tryInsertIdentityJob(params: {
			userId: string;
			imageKey: string;
			imageUrl: string;
			sessionId?: string;
			entryId?: string;
			source?: string;
		}): Promise<boolean> {
			const now = Date.now();
			const result = await this.db
				.prepare(
					`
					INSERT OR IGNORE INTO closet_identity_jobs (
						user_id, image_key, image_url, session_id, entry_id, source, status, created_at, updated_at
					)
					VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
					`
				)
				.bind(
					params.userId,
					params.imageKey,
					params.imageUrl,
					params.sessionId ?? null,
					params.entryId ?? null,
					params.source ?? 'session',
					now,
					now
				)
				.run();
			return (result.meta.changes ?? 0) > 0;
		}

		async getIdentityJob(userId: string, imageKey: string): Promise<ClosetIdentityJobRow | null> {
			const row = await this.db
				.prepare(
					`
					SELECT user_id, image_key, image_url, session_id, entry_id, source, status, outfit_id, extraction_json, created_at, updated_at
					FROM closet_identity_jobs
					WHERE user_id = ? AND image_key = ?
					`
				)
				.bind(userId, imageKey)
				.first<ClosetIdentityJobRow>();
			return row ?? null;
		}

		async saveIdentityJobExtraction(userId: string, imageKey: string, extractionJson: string): Promise<void> {
			const now = Date.now();
			await this.db
				.prepare(
					`
					UPDATE closet_identity_jobs
					SET extraction_json = ?, updated_at = ?
					WHERE user_id = ? AND image_key = ?
					`
				)
				.bind(extractionJson, now, userId, imageKey)
				.run();
		}

		async markIdentityJobDone(userId: string, imageKey: string, outfitId: string): Promise<void> {
			const now = Date.now();
			await this.db
				.prepare(
					`
					UPDATE closet_identity_jobs
					SET status = 'done', outfit_id = ?, updated_at = ?
					WHERE user_id = ? AND image_key = ?
					`
				)
				.bind(outfitId, now, userId, imageKey)
				.run();
		}

		/** Set queued/running/failed. Does not move a done job, and does not set done (use markIdentityJobDone). */
		async markIdentityJobStatus(
			userId: string,
			imageKey: string,
			status: Exclude<ClosetIdentityJobStatus, 'done'>
		): Promise<void> {
			const now = Date.now();
			await this.db
				.prepare(
					`
					UPDATE closet_identity_jobs
					SET status = ?, updated_at = ?
					WHERE user_id = ? AND image_key = ? AND status != 'done'
					`
				)
				.bind(status, now, userId, imageKey)
				.run();
		}

		async countIdentityJobsByStatus(userId: string): Promise<ClosetIdentityJobCounts> {
			const result = await this.db
				.prepare(
					`
					SELECT status, COUNT(*) as total
					FROM closet_identity_jobs
					WHERE user_id = ?
					GROUP BY status
					`
				)
				.bind(userId)
				.all<{ status: string; total: number }>();

			const counts: ClosetIdentityJobCounts = { queued: 0, running: 0, done: 0, failed: 0 };
			for (const row of result.results ?? []) {
				if (row.status === 'queued' || row.status === 'running' || row.status === 'done' || row.status === 'failed') {
					counts[row.status] = Number(row.total) || 0;
				}
			}
			return counts;
		}

		async touchIdentityProgressActivity(userId: string, atMs = Date.now()): Promise<void> {
			await this.db
				.prepare(
					`
					INSERT INTO closet_identity_progress (user_id, last_activity_at, last_started_at, last_settled_at)
					VALUES (?, ?, NULL, NULL)
					ON CONFLICT(user_id) DO UPDATE SET last_activity_at = excluded.last_activity_at
					`
				)
				.bind(userId, atMs)
				.run();
		}

		async getIdentityProgressState(userId: string): Promise<ClosetIdentityProgressRow | null> {
			const row = await this.db
				.prepare(
					`
					SELECT user_id, last_activity_at, last_started_at, last_settled_at
					FROM closet_identity_progress
					WHERE user_id = ?
					`
				)
				.bind(userId)
				.first<ClosetIdentityProgressRow>();
			return row ?? null;
		}

		async markIdentityProgressStarted(userId: string, atMs = Date.now()): Promise<void> {
			const result = await this.db
				.prepare(`UPDATE closet_identity_progress SET last_started_at = ? WHERE user_id = ?`)
				.bind(atMs, userId)
				.run();
			if ((result.meta.changes ?? 0) > 0) return;
			await this.db
				.prepare(
					`
					INSERT INTO closet_identity_progress (user_id, last_activity_at, last_started_at, last_settled_at)
					VALUES (?, ?, ?, NULL)
					`
				)
				.bind(userId, atMs, atMs)
				.run();
		}

		async markIdentityProgressSettled(userId: string, atMs = Date.now()): Promise<void> {
			const result = await this.db
				.prepare(`UPDATE closet_identity_progress SET last_settled_at = ? WHERE user_id = ?`)
				.bind(atMs, userId)
				.run();
			if ((result.meta.changes ?? 0) > 0) return;
			await this.db
				.prepare(
					`
					INSERT INTO closet_identity_progress (user_id, last_activity_at, last_started_at, last_settled_at)
					VALUES (?, ?, NULL, ?)
					`
				)
				.bind(userId, atMs, atMs)
				.run();
		}
	};
}
