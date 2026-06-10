import { SignJWT, importPKCS8 } from 'jose';
import { createPushTokensDB, PushTokensDB } from '../db';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export class PushService {
	constructor(
		private pushTokensDB: PushTokensDB,
		private serviceAccountJson: string
	) { }

	/**
	 * Retrieves a valid OAuth2 access token for the FCM API.
	 * Uses jose to sign a JWT with the service account's private key,
	 * then exchanges it for an access token. In-memory cached for reuse.
	 */
	private async getAccessToken(): Promise<string> {
		if (!this.serviceAccountJson || this.serviceAccountJson === 'dummy') {
			throw new Error('FCM_SERVICE_ACCOUNT_JSON is not configured or is set to dummy');
		}

		if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
			return cachedAccessToken.token;
		}

		let serviceAccount: any;
		try {
			serviceAccount = JSON.parse(this.serviceAccountJson);
		} catch (e) {
			console.error('Failed to parse FCM_SERVICE_ACCOUNT_JSON:', e);
			throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
		}

		const privateKeyPem = serviceAccount.private_key;
		const clientEmail = serviceAccount.client_email;

		if (!privateKeyPem || !clientEmail) {
			throw new Error('FCM service account is missing private_key or client_email');
		}

		// Import the PKCS#8 PEM private key for jose signing
		const privateKey = await importPKCS8(privateKeyPem, 'RS256');

		// Generate Google OAuth JWT
		const jwt = await new SignJWT({
			scope: 'https://www.googleapis.com/auth/firebase.messaging'
		})
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer(clientEmail)
			.setSubject(clientEmail)
			.setAudience('https://oauth2.googleapis.com/token')
			.setExpirationTime('1h')
			.setIssuedAt()
			.sign(privateKey);

		// Exchange JWT for access token
		const response = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: jwt
			})
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Google OAuth token exchange failed: ${response.status} ${errText}`);
		}

		const data = (await response.json()) as { access_token: string; expires_in: number };

		cachedAccessToken = {
			token: data.access_token,
			expiresAt: Date.now() + data.expires_in * 1000
		};

		return data.access_token;
	}

	/**
	 * Sends a push notification to all registered tokens of a user.
	 * Prunes any unregistered or stale tokens from the database.
	 */
	async sendPushNotification(
		userId: string,
		title: string,
		body: string,
		data?: Record<string, string>
	): Promise<void> {
		if (!this.serviceAccountJson || this.serviceAccountJson === 'dummy') {
			console.warn(`FCM not configured. Skipping push notification to user: ${userId}`);
			return;
		}

		const tokens = await this.pushTokensDB.getTokensByUserId(userId);
		if (tokens.length === 0) {
			console.log(`No registered push tokens found for user: ${userId}`);
			return;
		}

		let accessToken: string;
		let projectId: string;
		try {
			accessToken = await this.getAccessToken();
			const parsed = JSON.parse(this.serviceAccountJson);
			projectId = parsed.project_id;
			if (!projectId) {
				throw new Error('project_id missing from service account JSON');
			}
		} catch (e) {
			console.error('Failed to initialize FCM credentials:', e);
			return;
		}

		console.log(`Sending push notification to ${tokens.length} tokens for user ${userId}`);

		// Send to each token in parallel
		await Promise.allSettled(
			tokens.map(async (pushTokenObj) => {
				const { token } = pushTokenObj;
				try {
					const res = await fetch(
						`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
						{
							method: 'POST',
							headers: {
								'Authorization': `Bearer ${accessToken}`,
								'Content-Type': 'application/json'
							},
							body: JSON.stringify({
								message: {
									token,
									notification: {
										title,
										body
									},
									...(data ? { data } : {})
								}
							})
						}
					);

					if (!res.ok) {
						const errBody = (await res.json().catch(() => null)) as any;
						console.error(
							`FCM send failure for token on platform ${pushTokenObj.platform}:`,
							JSON.stringify(errBody)
						);

						const status = errBody?.error?.status;
						const code = errBody?.error?.code;
						const message = errBody?.error?.message?.toLowerCase() || '';

						const isUnregistered =
							status === 'NOT_FOUND' ||
							code === 404 ||
							message.includes('not found') ||
							message.includes('unregistered') ||
							message.includes('not registered') ||
							errBody?.error?.details?.some(
								(d: any) => d.reason === 'REGISTRATION_TOKEN_NOT_REGISTERED'
							);

						if (isUnregistered) {
							console.log(
								`Deleting stale/unregistered token for user ${userId} (${pushTokenObj.platform})`
							);
							await this.pushTokensDB.deleteToken(token, userId);
						}
					} else {
						console.log(`Successfully sent FCM notification to token on ${pushTokenObj.platform}`);
					}
				} catch (err) {
					console.error(`Error sending push notification to token:`, err);
				}
			})
		);
	}

	/**
	 * Sends a push notification asynchronously in the background using ExecutionContext.waitUntil.
	 * Catches and logs errors internally so route handlers do not need boilerplate try-catch.
	 */
	sendPushNotificationInBackground(
		userId: string,
		title: string,
		body: string,
		ctx?: ExecutionContext,
		data?: Record<string, string>
	): void {
		const promise = (async () => {
			try {
				await this.sendPushNotification(userId, title, body, data);
			} catch (err) {
				console.error(`Failed to send push notification background task for user ${userId}:`, err);
			}
		})();

		if (ctx?.waitUntil) {
			ctx.waitUntil(promise);
		}
	}
}

export const createPushService = (env: Env) => {
	const pushTokensDB = createPushTokensDB(env.GOSTYLENS_DB);
	return new PushService(pushTokensDB, env.FCM_SERVICE_ACCOUNT_JSON);
};
