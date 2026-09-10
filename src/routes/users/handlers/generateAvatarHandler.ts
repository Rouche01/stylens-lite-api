import { env } from 'cloudflare:workers';
import { error, RequestHandler } from 'itty-router';
import { createAvatarsDB, createUsersDB } from 'db';
import { createAvatarService, type AvatarGenerationJob } from 'services/avatar';
import { signDownloadUrlForKey } from 'utils/assets.utils';
import { logRouteError } from 'utils/error';
import { ApiRequest } from 'types';

/**
 * TEMP admin test hook: run AvatarService.generate in-request (no queue).
 * Remove once classification waitUntil is wired.
 *
 * POST /users/avatars/generate
 * Header: x-admin-api-key
 * Body: { userId, sourceImageKey, sourceImageUrl?, avatarId? }
 */
type GenerateAvatarBody = {
	userId?: string;
	sourceImageKey?: string;
	sourceImageUrl?: string;
	avatarId?: string;
};

const generateAvatarHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as GenerateAvatarBody;
		const userId = body.userId?.trim();
		const sourceImageKey = body.sourceImageKey?.trim();
		const sourceImageUrl = body.sourceImageUrl?.trim();
		let avatarId = body.avatarId?.trim();

		if (!userId) {
			return error(400, 'userId is required');
		}
		if (!sourceImageKey) {
			return error(400, 'sourceImageKey is required');
		}

		const usersDB = createUsersDB(env.GOSTYLENS_DB);
		const user = await usersDB.getUserById(userId);
		if (!user) {
			return error(404, 'User not found');
		}

		const avatarsDB = createAvatarsDB(env.GOSTYLENS_DB);
		const avatarService = createAvatarService(env, request.log);

		if (!avatarId) {
			const active = await avatarsDB.getActiveAvatar(userId);
			if (active?.status === 'ready') {
				return error(409, `User already has a ready avatar (${active.id})`);
			}
			if (active?.status === 'pending') {
				avatarId = active.id;
			} else {
				const claimed = await avatarsDB.claimPending({
					userId,
					sourceImageKey,
					sourceImageUrl,
					model: undefined,
				});
				if (!claimed) {
					return error(409, 'Could not claim a pending avatar row');
				}
				avatarId = claimed.id;
			}
		}

		const job: AvatarGenerationJob = {
			avatarId,
			userId,
			sourceImageKey,
			sourceImageUrl,
		};

		await avatarService.generate(job);

		const avatar = await avatarsDB.getById(avatarId);
		if (!avatar || avatar.status !== 'ready' || !avatar.avatar_image_key) {
			return error(409, `Avatar was not generated (status=${avatar?.status ?? 'missing'})`);
		}

		const imageUrl = await signDownloadUrlForKey(avatar.avatar_image_key);

		return new Response(
			JSON.stringify({
				message: 'Avatar generated',
				avatar: {
					...avatar,
					image_url: imageUrl,
				},
			}),
			{
				headers: { 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (err) {
		logRouteError(request.log, 'admin_generate_avatar_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default generateAvatarHandler;
