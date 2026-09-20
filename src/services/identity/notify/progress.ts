import type { ClosetDB, ClosetIdentityJobCounts } from '../../../db/closet';
import { closetIdentityStatusPayload, identityJobsProcessing } from '../../../db/closet';
import type { Logger } from '../../../utils/logger.utils';

export const IDENTITY_PROGRESS_SETTLE_SECONDS = 20;

export type ClosetIdentitySettleJob = {
	kind: 'closet_identity_settle';
	userId: string;
};

export type ClosetIdentityProgressPhase = 'started' | 'settled';

export type ClosetIdentityRealtimePayload = ReturnType<typeof closetIdentityStatusPayload> & {
	phase: ClosetIdentityProgressPhase;
};

export type ClosetIdentityProgressDecision =
	| { action: 'started' }
	| { action: 'silent' }
	| { action: 'retry'; delaySeconds: number }
	| { action: 'settled' }
	| { action: 'skip'; reason: 'idle' | 'already_settled' };

export function isClosetIdentitySettleJob(job: unknown): job is ClosetIdentitySettleJob {
	return (
		typeof job === 'object' &&
		job !== null &&
		'kind' in job &&
		(job as { kind?: unknown }).kind === 'closet_identity_settle'
	);
}

export function inFlightIdentityJobs(counts: ClosetIdentityJobCounts): number {
	return counts.queued + counts.running;
}

export function decideClosetIdentityProgress(params: {
	inFlight: number;
	lastActivityAt: number | null;
	lastStartedAt: number | null;
	lastSettledAt: number | null;
	nowMs: number;
	settleSeconds?: number;
}): ClosetIdentityProgressDecision {
	if (params.inFlight > 0) {
		const alreadyStartedThisWave =
			params.lastStartedAt != null &&
			(params.lastSettledAt == null || params.lastStartedAt > params.lastSettledAt);
		return alreadyStartedThisWave ? { action: 'silent' } : { action: 'started' };
	}

	if (params.lastActivityAt == null) {
		return { action: 'skip', reason: 'idle' };
	}

	const settleMs = (params.settleSeconds ?? IDENTITY_PROGRESS_SETTLE_SECONDS) * 1000;
	const ageMs = params.nowMs - params.lastActivityAt;
	if (ageMs < settleMs) {
		return {
			action: 'retry',
			delaySeconds: Math.max(1, Math.ceil((settleMs - ageMs) / 1000)),
		};
	}

	if (params.lastSettledAt != null && params.lastSettledAt >= params.lastActivityAt) {
		return { action: 'skip', reason: 'already_settled' };
	}

	return { action: 'settled' };
}

export async function scheduleClosetIdentitySettle(
	queue: Pick<Queue, 'send'>,
	userId: string,
	delaySeconds = IDENTITY_PROGRESS_SETTLE_SECONDS
): Promise<void> {
	const job: ClosetIdentitySettleJob = { kind: 'closet_identity_settle', userId };
	await queue.send(job, { delaySeconds });
}

export async function runClosetIdentityProgress(params: {
	userId: string;
	closet: Pick<
		ClosetDB,
		| 'countIdentityJobsByStatus'
		| 'getIdentityProgressState'
		| 'markIdentityProgressStarted'
		| 'markIdentityProgressSettled'
	>;
	realtime: {
		notifyClosetIdentityUpdated(userId: string, payload: ClosetIdentityRealtimePayload): Promise<void>;
	};
	log: Logger;
	nowMs?: number;
	queue?: Pick<Queue, 'send'>;
	scheduleOnRetry?: boolean;
}): Promise<ClosetIdentityProgressDecision> {
	const nowMs = params.nowMs ?? Date.now();
	const counts = await params.closet.countIdentityJobsByStatus(params.userId);
	const state = await params.closet.getIdentityProgressState(params.userId);
	const decision = decideClosetIdentityProgress({
		inFlight: inFlightIdentityJobs(counts),
		lastActivityAt: state?.last_activity_at ?? null,
		lastStartedAt: state?.last_started_at ?? null,
		lastSettledAt: state?.last_settled_at ?? null,
		nowMs,
	});

	if (decision.action === 'started') {
		await params.closet.markIdentityProgressStarted(params.userId, nowMs);
		await broadcastProgress(params, counts, 'started');
		params.log.info('closet_identity_progress_started', {
			user_id: params.userId,
			queued: counts.queued,
			running: counts.running,
		});
		return decision;
	}

	if (decision.action === 'settled') {
		await params.closet.markIdentityProgressSettled(params.userId, nowMs);
		await broadcastProgress(params, counts, 'settled');
		params.log.info('closet_identity_progress_settled', {
			user_id: params.userId,
			failed: counts.failed,
		});
		return decision;
	}

	if (decision.action === 'retry' && params.scheduleOnRetry && params.queue) {
		try {
			await scheduleClosetIdentitySettle(params.queue, params.userId, decision.delaySeconds);
		} catch (err) {
			params.log.warn('closet_identity_settle_enqueue_failed', { user_id: params.userId }, err);
		}
	}

	params.log.debug('closet_identity_progress_skip', {
		user_id: params.userId,
		processing: identityJobsProcessing(counts),
		decision_action: decision.action,
		decision_reason: decision.action === 'skip' ? decision.reason : undefined,
		retry_delay_seconds: decision.action === 'retry' ? decision.delaySeconds : undefined,
	});
	return decision;
}

async function broadcastProgress(
	params: {
		userId: string;
		realtime: {
			notifyClosetIdentityUpdated(userId: string, payload: ClosetIdentityRealtimePayload): Promise<void>;
		};
		log: Logger;
	},
	counts: ClosetIdentityJobCounts,
	phase: ClosetIdentityProgressPhase
): Promise<void> {
	try {
		await params.realtime.notifyClosetIdentityUpdated(params.userId, {
			...closetIdentityStatusPayload(counts),
			phase,
		});
	} catch (err) {
		params.log.warn('closet_identity_progress_broadcast_failed', { user_id: params.userId, phase }, err);
	}
}
