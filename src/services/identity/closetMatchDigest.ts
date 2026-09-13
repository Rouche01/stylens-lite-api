import type { ClosetDB } from '../../db';
import type { Logger } from '../../utils/logger.utils';
import type { PushService } from '../push.svc';

export const DIGEST_SETTLE_SECONDS = 600;

export type ClosetMatchDigestJob = {
	kind: 'closet_match_digest';
	userId: string;
};

export type ClosetMatchDigestDecision =
	| { action: 'skip'; reason: 'no_pending' | 'already_nudged' }
	| { action: 'retry'; delaySeconds: number }
	| { action: 'send' };

export function closetMatchDigestNotification(count: number): {
	title: string;
	body: string;
	data: Record<string, string>;
} {
	const n = Math.max(1, Math.floor(count));
	return {
		title: 'Confirm your closet',
		body: n === 1 ? 'You have 1 item to confirm' : `You have ${n} items to confirm`,
		data: {
			type: 'closet_matches',
			count: String(n),
		},
	};
}

export function decideClosetMatchDigest(params: {
	pendingCount: number;
	lastAskAt: number | null;
	lastNotifiedAt: number | null;
	nowMs: number;
	settleSeconds?: number;
}): ClosetMatchDigestDecision {
	if (params.pendingCount <= 0 || params.lastAskAt == null) {
		return { action: 'skip', reason: 'no_pending' };
	}

	const settleMs = (params.settleSeconds ?? DIGEST_SETTLE_SECONDS) * 1000;
	const ageMs = params.nowMs - params.lastAskAt;
	if (ageMs < settleMs) {
		return {
			action: 'retry',
			delaySeconds: Math.max(1, Math.ceil((settleMs - ageMs) / 1000)),
		};
	}

	if (params.lastNotifiedAt != null && params.lastNotifiedAt >= params.lastAskAt) {
		return { action: 'skip', reason: 'already_nudged' };
	}

	return { action: 'send' };
}

export async function scheduleClosetMatchDigest(
	queue: Queue,
	userId: string,
	delaySeconds = DIGEST_SETTLE_SECONDS
): Promise<void> {
	const job: ClosetMatchDigestJob = { kind: 'closet_match_digest', userId };
	await queue.send(job, { delaySeconds });
}

export async function runClosetMatchDigest(params: {
	userId: string;
	closet: Pick<ClosetDB, 'countPendingMatches' | 'getMatchNotifyState' | 'markMatchNotified'>;
	push: Pick<PushService, 'sendPushNotification'>;
	log: Logger;
	nowMs?: number;
}): Promise<ClosetMatchDigestDecision> {
	const nowMs = params.nowMs ?? Date.now();
	const pendingCount = await params.closet.countPendingMatches(params.userId);
	const state = await params.closet.getMatchNotifyState(params.userId);
	const decision = decideClosetMatchDigest({
		pendingCount,
		lastAskAt: state?.last_ask_at ?? null,
		lastNotifiedAt: state?.last_notified_at ?? null,
		nowMs,
	});

	if (decision.action !== 'send') {
		params.log.debug('closet_match_digest_skip', {
			user_id: params.userId,
			pending_count: pendingCount,
			decision_action: decision.action,
			decision_reason: decision.action === 'skip' ? decision.reason : undefined,
			retry_delay_seconds: decision.action === 'retry' ? decision.delaySeconds : undefined,
		});
		return decision;
	}

	const message = closetMatchDigestNotification(pendingCount);
	await params.push.sendPushNotification(params.userId, message.title, message.body, message.data);
	await params.closet.markMatchNotified(params.userId, nowMs);
	params.log.info('closet_match_digest_sent', {
		user_id: params.userId,
		pending_count: pendingCount,
	});
	return decision;
}

export const createClosetMatchDigestScheduler = (envBindings: Env, log: Logger) => ({
	async schedule(userId: string): Promise<void> {
		try {
			await scheduleClosetMatchDigest(envBindings.CLOSET_MATCH_DIGEST_QUEUE, userId);
		} catch (err) {
			log.warn('closet_match_digest_enqueue_failed', { user_id: userId }, err);
		}
	},
});
