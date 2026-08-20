import { SignJWT, importPKCS8 } from 'jose';
import { createPushTokensDB, PushTokensDB } from '../db';
import { Logger, createLogger, maskToken } from 'utils/logger.utils';

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

type FcmErrorDetail = {
	'@type'?: string;
	errorCode?: string;
	statusCode?: number;
	reason?: string;
};

type FcmErrorBody = {
	error?: {
		status?: string;
		code?: number;
		message?: string;
		details?: FcmErrorDetail[];
	};
};

export type PushSendResult = {
	tokensFound: number;
	tokensSent: number;
	tokensFailed: number;
	staleTokensRemoved: number;
};

type TokenSendOutcome = 'sent' | 'failed' | 'stale_removed';

const STALE_FCM_ERROR_CODES = new Set(['UNREGISTERED']);

export function isStaleFcmToken(errBody: FcmErrorBody | null): boolean {
	if (!errBody?.error) {
		return false;
	}

	const { status, code, message, details } = errBody.error;
	const normalizedMessage = message?.toLowerCase() ?? '';

	if (status === 'NOT_FOUND' || code === 404) {
		return true;
	}

	if (
		normalizedMessage.includes('not found') ||
		normalizedMessage.includes('unregistered') ||
		normalizedMessage.includes('not registered')
	) {
		return true;
	}

	for (const detail of details ?? []) {
		if (detail.reason === 'REGISTRATION_TOKEN_NOT_REGISTERED') {
			return true;
		}
		if (detail.errorCode && STALE_FCM_ERROR_CODES.has(detail.errorCode)) {
			return true;
		}
	}

	return false;
}

function staleFcmErrorCode(errBody: FcmErrorBody | null): string | undefined {
	for (const detail of errBody?.error?.details ?? []) {
		if (detail.errorCode && STALE_FCM_ERROR_CODES.has(detail.errorCode)) {
			return detail.errorCode;
		}
	}
	return undefined;
}

function logFcmErrorDetails(log: Logger, errBody: FcmErrorBody, expectedStale: boolean): void {
	const details = errBody.error?.details ?? [];
	for (const detail of details) {
		const type = detail['@type'] ?? '';
		if (type.includes('FcmError') && detail.errorCode) {
			const context = { fcm_error_code: detail.errorCode };
			if (expectedStale) {
				log.warn('fcm_error_code', context);
			} else {
				log.error('fcm_error_code', context);
			}
		}
		if (type.includes('ApnsError')) {
			const context = {
				apns_status_code: detail.statusCode,
				apns_reason: detail.reason ?? 'unknown',
			};
			if (expectedStale) {
				log.warn('apns_error', context);
			} else {
				log.error('apns_error', context);
			}
		}
	}
}

export class PushService {
	constructor(
		private pushTokensDB: PushTokensDB,
		private serviceAccountJson: string,
		private log: Logger
	) { }

	private parseServiceAccount(): FcmServiceAccount {
		if (!this.serviceAccountJson || this.serviceAccountJson === 'dummy') {
			throw new Error('FCM_SERVICE_ACCOUNT_JSON is not configured or is set to dummy');
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(this.serviceAccountJson);
		} catch (e) {
			this.log.error('fcm_service_account_parse_failed', {}, e);
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
			this.log.debug('fcm_oauth_using_cached_token', {
				token_length: cachedAccessToken.token.length,
				expires_in_seconds: Math.round((cachedAccessToken.expiresAt - Date.now()) / 1000),
			});
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

		this.log.debug('fcm_oauth_token_exchange_succeeded', {
			token_length: data.access_token.length,
			expires_in_seconds: data.expires_in,
			client_email: clientEmail,
		});

		return data.access_token;
	}

	private async sendToToken(params: {
		pushTokenObj: { token: string; platform: 'ios' | 'android' };
		userId: string;
		title: string;
		body: string;
		data?: Record<string, string>;
		accessToken: string;
		fcmEndpoint: string;
		log: Logger;
	}): Promise<TokenSendOutcome> {
		const { pushTokenObj, userId, title, body, data, accessToken, fcmEndpoint, log } = params;
		const { token } = pushTokenObj;

		try {
			log.debug('fcm_send_attempt', {
				platform: pushTokenObj.platform,
				token: maskToken(token),
			});

			const res = await fetch(fcmEndpoint, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					message: {
						token,
						notification: {
							title,
							body,
						},
						...(data ? { data } : {}),
					},
				}),
			});

			if (!res.ok) {
				const errBody = (await res.json().catch(() => null)) as FcmErrorBody | null;
				const staleToken = isStaleFcmToken(errBody);

				if (staleToken) {
					log.info('fcm_stale_token_deleted', {
						platform: pushTokenObj.platform,
						fcm_error_code: staleFcmErrorCode(errBody),
						http_status: res.status,
						fcm_status: errBody?.error?.status,
					});
					await this.pushTokensDB.deleteToken(token, userId);
					return 'stale_removed';
				}

				log.error('fcm_send_failed', {
					platform: pushTokenObj.platform,
					http_status: res.status,
					fcm_status: errBody?.error?.status,
					fcm_code: errBody?.error?.code,
				});
				if (errBody) {
					logFcmErrorDetails(log, errBody, false);
				}

				return 'failed';
			}

			log.debug('fcm_send_succeeded', {
				platform: pushTokenObj.platform,
			});
			return 'sent';
		} catch (err) {
			log.error('fcm_send_exception', { platform: pushTokenObj.platform }, err);
			return 'failed';
		}
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
	): Promise<PushSendResult> {
		const log = this.log.child({ user_id: userId });

		if (!this.serviceAccountJson || this.serviceAccountJson === 'dummy') {
			log.warn('fcm_not_configured');
			throw new Error('FCM_SERVICE_ACCOUNT_JSON is not configured');
		}

		const tokens = await this.pushTokensDB.getTokensByUserId(userId);
		if (tokens.length === 0) {
			log.debug('no_push_tokens_found');
			return {
				tokensFound: 0,
				tokensSent: 0,
				tokensFailed: 0,
				staleTokensRemoved: 0,
			};
		}

		const serviceAccount = this.parseServiceAccount();
		const accessToken = await this.getAccessToken(serviceAccount);

		const { project_id: projectId, client_email: clientEmail } = serviceAccount;
		const fcmEndpoint = fcmSendMessageUrl(projectId);
		log.debug('fcm_send_start', {
			project_id: projectId,
			service_account: clientEmail,
			fcm_endpoint: fcmEndpoint,
			token_count: tokens.length,
		});

		const outcomes = await Promise.all(
			tokens.map((pushTokenObj) =>
				this.sendToToken({
					pushTokenObj,
					userId,
					title,
					body,
					data,
					accessToken,
					fcmEndpoint,
					log,
				})
			)
		);

		const result: PushSendResult = {
			tokensFound: tokens.length,
			tokensSent: outcomes.filter((o) => o === 'sent').length,
			tokensFailed: outcomes.filter((o) => o === 'failed').length,
			staleTokensRemoved: outcomes.filter((o) => o === 'stale_removed').length,
		};

		log.info('fcm_send_complete', result);
		return result;
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
				this.log.error('fcm_background_send_failed', { user_id: userId }, err);
			}
		})();

		if (ctx?.waitUntil) {
			ctx.waitUntil(promise);
		}
	}
}

export const createPushService = (env: Env, log?: Logger) => {
	const pushTokensDB = createPushTokensDB(env.GOSTYLENS_DB);
	const logger = (log ?? createLogger({ env: env.ENV_NAME })).child({ service: 'push' });
	return new PushService(pushTokensDB, env.FCM_SERVICE_ACCOUNT_JSON, logger);
};
