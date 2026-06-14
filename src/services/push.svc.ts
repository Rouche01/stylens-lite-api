import { SignJWT, importPKCS8 } from 'jose';
import { createPushTokensDB, PushTokensDB } from '../db';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const fcmSendMessageUrl = (projectId: string) =>
	`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

type FcmServiceAccount = {
	project_id: string;
	client_email: string;
	private_key: string;
};

function maskToken(token: string): string {
	if (token.length <= 12) return '***';
	return `${token.slice(0, 8)}...${token.slice(-4)} (${token.length} chars)`;
}

function logFcmErrorDetails(errBody: any): void {
	const details = errBody?.error?.details ?? [];
	for (const detail of details) {
		const type = detail['@type'] ?? '';
		if (type.includes('FcmError') && detail.errorCode) {
			console.error(`FCM errorCode: ${detail.errorCode}`);
		}
		if (type.includes('ApnsError')) {
			console.error(
				`APNs error: statusCode=${detail.statusCode}, reason=${detail.reason ?? 'unknown'}`
			);
		}
	}
}

export class PushService {
	constructor(
		private pushTokensDB: PushTokensDB,
		private serviceAccountJson: string,
		private envName: string
	) { }

	private logDebug(...args: unknown[]): void {
		if (this.envName !== 'production') {
			console.log(...args);
		}
	}

	private parseServiceAccount(): FcmServiceAccount {
		if (!this.serviceAccountJson || this.serviceAccountJson === 'dummy') {
			throw new Error('FCM_SERVICE_ACCOUNT_JSON is not configured or is set to dummy');
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(this.serviceAccountJson);
		} catch (e) {
			console.error('Failed to parse FCM_SERVICE_ACCOUNT_JSON:', e);
			throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
		}

		const serviceAccount = parsed as Partial<FcmServiceAccount>;
		const { project_id, client_email, private_key } = serviceAccount;

		if (!project_id) {
			throw new Error('project_id missing from service account JSON');
		}
		if (!client_email || !private_key) {
			throw new Error('FCM service account is missing private_key or client_email');
		}

		return { project_id, client_email, private_key };
	}

	/**
	 * Retrieves a valid OAuth2 access token for the FCM API.
	 * Uses jose to sign a JWT with the service account's private key,
	 * then exchanges it for an access token. In-memory cached for reuse.
	 */
	private async getAccessToken(serviceAccount: FcmServiceAccount): Promise<string> {
		if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
			this.logDebug(
				`FCM OAuth: using cached access token (${cachedAccessToken.token.length} chars, expires in ${Math.round((cachedAccessToken.expiresAt - Date.now()) / 1000)}s)`
			);
			return cachedAccessToken.token;
		}

		const { private_key: privateKeyPem, client_email: clientEmail } = serviceAccount;

		// Import the PKCS#8 PEM private key for jose signing
		const privateKey = await importPKCS8(privateKeyPem, 'RS256');

		// Generate Google OAuth JWT
		const jwt = await new SignJWT({
			scope: FCM_MESSAGING_SCOPE
		})
			.setProtectedHeader({ alg: 'RS256' })
			.setIssuer(clientEmail)
			.setSubject(clientEmail)
			.setAudience(GOOGLE_OAUTH_TOKEN_URL)
			.setExpirationTime('1h')
			.setIssuedAt()
			.sign(privateKey);

		// Exchange JWT for access token
		const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
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

		this.logDebug(
			`FCM OAuth: token exchange succeeded (${data.access_token.length} chars, expires_in=${data.expires_in}s, client=${clientEmail})`
		);

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
			this.logDebug(`No registered push tokens found for user: ${userId}`);
			return;
		}

		let accessToken: string;
		let serviceAccount: FcmServiceAccount;
		try {
			serviceAccount = this.parseServiceAccount();
			accessToken = await this.getAccessToken(serviceAccount);
		} catch (e) {
			console.error('Failed to initialize FCM credentials:', e);
			return;
		}

		const { project_id: projectId, client_email: clientEmail } = serviceAccount;
		const fcmEndpoint = fcmSendMessageUrl(projectId);
		this.logDebug(
			`FCM send: user=${userId}, project=${projectId}, serviceAccount=${clientEmail}, endpoint=${fcmEndpoint}, tokens=${tokens.length}`
		);

		// Send to each token in parallel
		await Promise.allSettled(
			tokens.map(async (pushTokenObj) => {
				const { token } = pushTokenObj;
				try {
					this.logDebug(
						`FCM send attempt: platform=${pushTokenObj.platform}, token=${maskToken(token)}`
					);

					const res = await fetch(
						fcmEndpoint,
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
							`FCM send failure for token on platform ${pushTokenObj.platform} (HTTP ${res.status}):`,
							JSON.stringify(errBody)
						);
						logFcmErrorDetails(errBody);

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
						this.logDebug(`Successfully sent FCM notification to token on ${pushTokenObj.platform}`);
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
	return new PushService(pushTokensDB, env.FCM_SERVICE_ACCOUNT_JSON, env.ENV_NAME);
};
