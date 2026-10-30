import { error, RequestHandler } from 'itty-router';
import {
	createOutfitIdentityService,
	IdentityBusyError,
	IdentityRunLogEvents,
	identityRunCompletedLogContext,
	mintIdentityRunId,
	summarizeIdentityRunItems,
} from 'services/identity';
import {
	buildIdentityRunArtifact,
	persistIdentityRunArtifact,
} from 'services/identity/logging/runArtifact';
import { getIsolatedItemUrl, signDownloadUrlForKey } from 'utils/assets.utils';
import { createUsersDB } from 'db';
import { env } from 'cloudflare:workers';
import { ApiRequest, AuthRequest } from 'types';
import { logRouteError } from 'utils/error';

type ExtractOutfitBody = {
	imageUrl?: string;
	imageKey?: string;
	userId?: string;
};

const extractOutfitHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const body = (await request.json()) as ExtractOutfitBody;
		const imageKeyParam = body.imageKey?.trim();
		let imageUrl = body.imageUrl?.trim();

		if (imageKeyParam && !imageUrl) {
			imageUrl = await signDownloadUrlForKey(imageKeyParam);
		}

		if (!imageUrl) {
			return error(400, 'imageUrl is required to extract from an outfit (or imageKey for admin)');
		}

		let userId: string | undefined;
		if (request.isAdmin) {
			userId = body.userId?.trim();
			if (!userId) {
				return error(400, 'userId is required when extracting with an admin API key');
			}
			const user = await createUsersDB(env.GOSTYLENS_DB).getUserById(userId);
			if (!user) {
				return error(404, 'User not found');
			}
		} else {
			userId = (request as AuthRequest).user?.dbId;
			if (!userId) {
				return error(401, 'Unauthorized: User profile not found in database. Please complete onboarding.');
			}
		}

		let imageKey = imageKeyParam || imageUrl;
		try {
			if (!imageKeyParam && imageUrl.startsWith('http')) {
				const url = new URL(imageUrl);
				imageKey = url.pathname.slice(1);
			}
		} catch {
			// Fallback to imageUrl
		}

		const identityRunId = mintIdentityRunId();
		const processed = await createOutfitIdentityService(env, request.log).process({
			userId,
			imageUrl,
			imageKey,
			identityRunId,
			signal: request.signal,
		});

		if (!processed) {
			request.log.warn('outfit_extraction_empty_result', { identity_run_id: identityRunId });
			return error(400, 'Failed to extract outfit items');
		}

		const summary = summarizeIdentityRunItems(processed.items);
		request.log.info(
			IdentityRunLogEvents.JOB_COMPLETED,
			identityRunCompletedLogContext({
				identity_run_id: identityRunId,
				user_id: userId,
				image_key: imageKey,
				outfit_id: processed.outfit_id,
				summary,
			})
		);
		await persistIdentityRunArtifact({
			envName: env.ENV_NAME,
			log: request.log,
			artifact: buildIdentityRunArtifact({
				identity_run_id: identityRunId,
				envName: env.ENV_NAME,
				source: 'extract',
				user_id: userId,
				image_key: imageKey,
				outfit_id: processed.outfit_id,
				summary,
			}),
		});

		const requestUrl = new URL(request.url);
		const domain = requestUrl.host;

		// Full identity_probe (1024-d vector) is admin/eval only — never ship to the app.
		const includeProbe = Boolean(request.isAdmin);
		const enrichedItems = processed.items.map((item) => {
			const { identity_probe, ...rest } = item;
			return {
				...rest,
				isolated_image_url: getIsolatedItemUrl({
					domain,
					imageUrl,
					imageKey,
					boundingBox: item.bounding_box,
					dimensions: processed.extraction.image_dimensions,
				}),
				...(includeProbe && identity_probe ? { identity_probe } : {}),
			};
		});

		const enrichedPayload = {
			...processed.extraction,
			outfit_id: processed.outfit_id,
			items: enrichedItems,
		};

		return new Response(JSON.stringify(enrichedPayload), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		logRouteError(request.log, 'extract_outfit_failed', err);
		if (err instanceof IdentityBusyError) {
			return error(409, err.message);
		}
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default extractOutfitHandler;
