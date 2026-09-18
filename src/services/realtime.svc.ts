import { env } from 'cloudflare:workers';

export class RealtimeService {
	constructor(
		private svcUrl: string,
		private svcRoleKey: string
	) {}

	/**
	 * Broadcasts an event to a Supabase Realtime channel.
	 * This allows the Flutter app to receive instant updates.
	 */
	async broadcast(topic: string, event: string, payload: any) {
		const res = await fetch(`${this.svcUrl}/realtime/v1/api/broadcast`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.svcRoleKey}`,
				'apikey': this.svcRoleKey,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				messages: [
					{
						topic,
						event,
						payload
					}
				]
			})
		});

		if (!res.ok) {
			const errorText = await res.text();
			console.error(`Failed to broadcast realtime event: ${res.status} ${errorText}`);
		}
	}

	/**
	 * Specifically notifies the app about a limit change.
	 */
	async notifyLimitChanged(userId: string, hasReachedLimit: boolean) {
		await this.broadcast(`user-limits:${userId}`, 'limit_updated', {
			userId,
			hasReachedLimit
		});
	}

	/**
	 * Batch closet-identity progress. Only started (idle → in-flight) and settled
	 * (in-flight stayed 0 after the quiet window) — never per photo.
	 */
	async notifyClosetIdentityUpdated(
		userId: string,
		payload: {
			processing: boolean;
			queued: number;
			running: number;
			failed: number;
			phase: 'started' | 'settled';
		}
	) {
		await this.broadcast(`closet-identity:${userId}`, 'closet_identity_updated', payload);
	}
}

export const createRealtimeService = () => {
	return new RealtimeService(env.SUPABASE_URL, env.SUPABASE_ROLE_KEY);
};
