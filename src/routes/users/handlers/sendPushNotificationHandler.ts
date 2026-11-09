import { env } from 'cloudflare:workers';
import { createUsersDB } from 'db';
import { error, RequestHandler } from 'itty-router';
import { createPushService } from 'services/push.svc';
import { apiError } from 'utils/error';

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 500;

type SendPushNotificationBody = {
	userId?: string;
	title?: string;
	body?: string;
	data?: Record<string, unknown>;
};

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	return Object.values(value).every((entry) => typeof entry === 'string');
}

const sendPushNotificationHandler: RequestHandler = async (request) => {
	try {
		const body = (await request.json()) as SendPushNotificationBody;

		if (!body.userId) {
			return error(400, 'userId is required');
		}
		if (!body.title?.trim()) {
			return error(400, 'title is required');
		}
		if (!body.body?.trim()) {
			return error(400, 'body is required');
		}
		if (body.title.length > MAX_TITLE_LENGTH) {
			return error(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
		}
		if (body.body.length > MAX_BODY_LENGTH) {
			return error(400, `body must be at most ${MAX_BODY_LENGTH} characters`);
		}
		if (body.data !== undefined && !isStringRecord(body.data)) {
			return error(400, 'data values must all be strings');
		}

		const usersDB = createUsersDB(env.GOSTYLENS_DB);
		const user = await usersDB.getUserById(body.userId);
		if (!user) {
			return error(404, 'User not found');
		}

		const pushService = createPushService(env, request.log);
		const result = await pushService.sendPushNotification(
			body.userId,
			body.title.trim(),
			body.body.trim(),
			body.data
		);

		if (result.tokensFound === 0) {
			return apiError(422, 'User has no registered push tokens', 'NO_PUSH_TOKENS');
		}

		return new Response(
			JSON.stringify({
				message: 'Push notification sent',
				userId: body.userId,
				...result,
			}),
			{
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (err) {
		if (err instanceof Error) {
			if (err.message.includes('FCM_SERVICE_ACCOUNT_JSON is not configured')) {
				return apiError(503, 'Push notifications are not configured', 'FCM_NOT_CONFIGURED');
			}
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default sendPushNotificationHandler;
