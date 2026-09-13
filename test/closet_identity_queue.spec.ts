import { describe, expect, it } from 'vitest';
import type { ClosetIdentityJobRow } from '../src/db/closet';
import {
	IDENTITY_BUSY_RETRY_SECONDS,
	IDENTITY_ERROR_RETRY_SECONDS,
	collectOutfitIdentityImages,
	enqueueClosetIdentityFromClassification,
	enqueueClosetIdentityJobs,
	runClosetIdentityJob,
	type ClosetIdentityQueueJob,
} from '../src/services/identity/closetIdentityJob';
import { IdentityBusyError, type ProcessOutfitImageResult } from '../src/services/identity/processOutfitImage';
import { isAvatarGenerationQueue, isClosetIdentityQueue, isClosetMatchDigestQueue } from '../src/queues';
import type { StyleEntryTag } from '../src/db/types';
import type { MessageEntry, RemoteImage } from '../src/utils/types';
import type { Logger } from '../src/utils/logger.utils';

const PRIMARY: StyleEntryTag['tag'] = 'session_state:primary_outfit_image';
const ALT: StyleEntryTag['tag'] = 'session_state:alt_outfit_image';

describe('isClosetIdentityQueue', () => {
	it('matches identity queue names', () => {
		expect(isClosetIdentityQueue('closet-identity')).toBe(true);
		expect(isClosetIdentityQueue('closet-identity-staging')).toBe(true);
		expect(isClosetIdentityQueue('closet-match-digest')).toBe(false);
		expect(isClosetMatchDigestQueue('closet-identity')).toBe(false);
		expect(isAvatarGenerationQueue('closet-identity')).toBe(false);
	});
});

describe('collectOutfitIdentityImages', () => {
	it('collects every unique image on an outfit-tagged message', () => {
		const imgA = remoteImage('users/u1/a.jpg');
		const imgB = remoteImage('users/u1/b.jpg');
		const message: MessageEntry = {
			role: 'user',
			remoteImages: [imgA, imgB],
		};
		const tags: StyleEntryTag[] = [
			outfitTag(PRIMARY, [imgA]),
			outfitTag(ALT, [imgB]),
		];

		expect(collectOutfitIdentityImages(message, tags)).toEqual([imgA, imgB]);
	});

	it('does not collect images when the message is not outfit-tagged', () => {
		const image = remoteImage('users/u1/a.jpg');
		const message: MessageEntry = { role: 'user', remoteImages: [image] };
		const tags: StyleEntryTag[] = [
			{ tag: 'session_state:occasion', payload: { occasion: 'wedding' } },
		];

		expect(collectOutfitIdentityImages(message, tags)).toEqual([]);
	});

	it('dedupes the same key from payload and message images', () => {
		const image = remoteImage('users/u1/a.jpg');
		const message: MessageEntry = { role: 'user', remoteImages: [image] };
		const tags: StyleEntryTag[] = [outfitTag(PRIMARY, [image])];

		expect(collectOutfitIdentityImages(message, tags)).toEqual([image]);
	});
});

describe('enqueueClosetIdentityJobs', () => {
	it('enqueues one job per unique outfit image', async () => {
		const queue = memoryQueue();
		const closet = memoryJobs();
		const images = [remoteImage('users/u1/a.jpg'), remoteImage('users/u1/b.jpg')];

		const result = await enqueueClosetIdentityJobs({
			queue,
			closet,
			log: silentLogger(),
			userId: 'u1',
			images,
			sessionId: 's1',
			entryId: 'e1',
		});

		expect(result).toEqual({ enqueued: 2, skipped: 0 });
		expect(queue.sent).toHaveLength(2);
		expect(queue.sent.map((job) => job.imageKey)).toEqual(['users/u1/a.jpg', 'users/u1/b.jpg']);
		expect(closet.rows.size).toBe(2);
	});

	it('does not enqueue non-outfit tags', async () => {
		const queue = memoryQueue();
		const closet = memoryJobs();
		const result = await enqueueClosetIdentityFromClassification({
			queue,
			closet,
			log: silentLogger(),
			userId: 'u1',
			message: { role: 'user', remoteImages: [remoteImage('users/u1/a.jpg')] },
			tags: [{ tag: 'session_state:occasion', payload: { occasion: 'wedding' } }],
			entryId: 'e1',
		});

		expect(result).toEqual({ enqueued: 0, skipped: 0 });
		expect(queue.sent).toHaveLength(0);
	});

	it('skips a photo that already finished identity', async () => {
		const queue = memoryQueue();
		const closet = memoryJobs();
		closet.rows.set('u1|users/u1/a.jpg', jobRow({ status: 'done' }));

		const result = await enqueueClosetIdentityJobs({
			queue,
			closet,
			log: silentLogger(),
			userId: 'u1',
			images: [remoteImage('users/u1/a.jpg')],
			entryId: 'e1',
		});

		expect(result).toEqual({ enqueued: 0, skipped: 1 });
		expect(queue.sent).toHaveLength(0);
	});

	it('re-sends a queued job so a lost queue message can recover', async () => {
		const queue = memoryQueue();
		const closet = memoryJobs();
		closet.rows.set('u1|users/u1/a.jpg', jobRow({ status: 'queued' }));

		const result = await enqueueClosetIdentityJobs({
			queue,
			closet,
			log: silentLogger(),
			userId: 'u1',
			images: [remoteImage('users/u1/a.jpg')],
			entryId: 'e1',
		});

		expect(result).toEqual({ enqueued: 1, skipped: 0 });
		expect(queue.sent).toHaveLength(1);
	});
});

describe('runClosetIdentityJob', () => {
	it('retries IdentityBusyError instead of completing', async () => {
		const closet = memoryJobs();
		closet.rows.set('u1|users/u1/a.jpg', jobRow({ status: 'queued' }));
		const message = mockQueueMessage(queueJob());

		const decision = await runClosetIdentityJob({
			job: message.body,
			closet,
			process: async () => {
				throw new IdentityBusyError('u1');
			},
			log: silentLogger(),
		});
		applyQueueDecision(message, decision);

		expect(decision).toEqual({
			action: 'retry',
			delaySeconds: IDENTITY_BUSY_RETRY_SECONDS,
			reason: 'busy',
		});
		expect(message.acks).toBe(0);
		expect(message.retries).toEqual([{ delaySeconds: IDENTITY_BUSY_RETRY_SECONDS }]);
		expect(closet.rows.get('u1|users/u1/a.jpg')?.status).toBe('queued');
	});

	it('acks an already completed job without processing', async () => {
		const closet = memoryJobs();
		closet.rows.set('u1|users/u1/a.jpg', jobRow({ status: 'done', outfit_id: 'outfit-1' }));
		let processed = 0;

		const decision = await runClosetIdentityJob({
			job: queueJob(),
			closet,
			process: async () => {
				processed += 1;
				return null;
			},
			log: silentLogger(),
		});

		expect(decision).toEqual({ action: 'ack', reason: 'done' });
		expect(processed).toBe(0);
	});

	it('marks the job done after process succeeds', async () => {
		const closet = memoryJobs();
		closet.rows.set('u1|users/u1/a.jpg', jobRow({ status: 'queued' }));

		const decision = await runClosetIdentityJob({
			job: queueJob(),
			closet,
			process: async (params) => {
				await params.onExtracted?.({ items: [] } as never);
				return {
					outfit_id: 'outfit-1',
					image_key: params.imageKey,
					extraction: { items: [] } as never,
					items: [],
				} satisfies ProcessOutfitImageResult;
			},
			log: silentLogger(),
		});

		expect(decision).toEqual({ action: 'ack', reason: 'completed' });
		expect(closet.rows.get('u1|users/u1/a.jpg')?.status).toBe('done');
		expect(closet.rows.get('u1|users/u1/a.jpg')?.outfit_id).toBe('outfit-1');
		expect(closet.rows.get('u1|users/u1/a.jpg')?.extraction_json).toBeTruthy();
	});

	it('retries an empty extract without marking the job done', async () => {
		const closet = memoryJobs();
		closet.rows.set('u1|users/u1/a.jpg', jobRow({ status: 'queued' }));

		const decision = await runClosetIdentityJob({
			job: queueJob(),
			closet,
			process: async () => null,
			log: silentLogger(),
		});

		expect(decision).toEqual({
			action: 'retry',
			delaySeconds: IDENTITY_ERROR_RETRY_SECONDS,
			reason: 'extract_empty',
		});
		expect(closet.rows.get('u1|users/u1/a.jpg')?.status).toBe('queued');
	});
});

function outfitTag(tag: StyleEntryTag['tag'], images: RemoteImage[]): StyleEntryTag {
	return { tag, payload: { images } };
}

function remoteImage(key: string): RemoteImage {
	return { key, url: `https://img/${key}` };
}

function queueJob(): ClosetIdentityQueueJob {
	return {
		kind: 'closet_identity',
		userId: 'u1',
		imageKey: 'users/u1/a.jpg',
		imageUrl: 'https://img/users/u1/a.jpg',
		source: 'session',
	};
}

function jobRow(overrides: Partial<ClosetIdentityJobRow> = {}): ClosetIdentityJobRow {
	return {
		user_id: 'u1',
		image_key: 'users/u1/a.jpg',
		image_url: 'https://img/users/u1/a.jpg',
		session_id: null,
		entry_id: 'e1',
		source: 'session',
		status: 'queued',
		outfit_id: null,
		extraction_json: null,
		created_at: 1,
		updated_at: 1,
		...overrides,
	};
}

function memoryQueue() {
	const sent: ClosetIdentityQueueJob[] = [];
	return {
		sent,
		async send(job: ClosetIdentityQueueJob) {
			sent.push(job);
		},
	};
}

function memoryJobs() {
	const rows = new Map<string, ClosetIdentityJobRow>();
	const keyOf = (userId: string, imageKey: string) => `${userId}|${imageKey}`;
	return {
		rows,
		async tryInsertIdentityJob(params: {
			userId: string;
			imageKey: string;
			imageUrl: string;
			sessionId?: string;
			entryId?: string;
			source?: string;
		}): Promise<boolean> {
			const key = keyOf(params.userId, params.imageKey);
			if (rows.has(key)) return false;
			rows.set(
				key,
				jobRow({
					user_id: params.userId,
					image_key: params.imageKey,
					image_url: params.imageUrl,
					session_id: params.sessionId ?? null,
					entry_id: params.entryId ?? null,
					source: params.source ?? 'session',
					status: 'queued',
				})
			);
			return true;
		},
		async getIdentityJob(userId: string, imageKey: string) {
			return rows.get(keyOf(userId, imageKey)) ?? null;
		},
		async saveIdentityJobExtraction(userId: string, imageKey: string, extractionJson: string) {
			const row = rows.get(keyOf(userId, imageKey));
			if (!row) return;
			row.extraction_json = extractionJson;
		},
		async markIdentityJobDone(userId: string, imageKey: string, outfitId: string) {
			const row = rows.get(keyOf(userId, imageKey));
			if (!row) return;
			row.status = 'done';
			row.outfit_id = outfitId;
		},
	};
}

function mockQueueMessage(body: ClosetIdentityQueueJob) {
	return {
		body,
		acks: 0,
		retries: [] as Array<{ delaySeconds?: number } | undefined>,
		ack() {
			this.acks += 1;
		},
		retry(opts?: { delaySeconds?: number }) {
			this.retries.push(opts);
		},
	};
}

function applyQueueDecision(
	message: ReturnType<typeof mockQueueMessage>,
	decision: { action: 'ack' | 'retry'; delaySeconds?: number }
) {
	if (decision.action === 'retry') {
		message.retry({ delaySeconds: decision.delaySeconds });
		return;
	}
	message.ack();
}

function silentLogger(): Logger {
	const log: Logger = {
		debug() {},
		info() {},
		warn() {},
		error() {},
		child() {
			return log;
		},
	};
	return log;
}
