import { error, RequestHandler } from 'itty-router';
import { env } from 'cloudflare:workers';
import {
	ClosetMatchNotFoundError,
	ClosetMatchResolvedError,
	createOutfitIdentityService,
} from 'services/identity';
import { ApiRequest } from 'types';
import { logRouteError } from 'utils/error';
import { isErrorResponse, requireClosetUserId } from './closetUser';

type ResolveClosetMatchBody = {
	decision?: string;
	userId?: string;
};

/**
 * POST resolve for a pending closet match.
 * Must stay free of IdentityBusyError / writer-lock waits; Replicate only if probe missing.
 */
const resolveClosetMatchHandler: RequestHandler<ApiRequest> = async (request) => {
	try {
		const matchId = request.params.id?.trim();
		if (!matchId) {
			return error(400, 'match id is required');
		}

		const body = ((await request.json().catch(() => ({}))) ?? {}) as ResolveClosetMatchBody;
		const decision = body.decision?.trim();
		if (decision !== 'same' && decision !== 'new') {
			return error(400, 'decision must be "same" or "new"');
		}

		const userIdOrError = await requireClosetUserId(request, body.userId);
		if (isErrorResponse(userIdOrError)) return userIdOrError;

		const result = await createOutfitIdentityService(env, request.log).resolveMatch({
			userId: userIdOrError,
			matchId,
			decision,
			signal: request.signal,
		});

		if (result.identity_status === 'failed') {
			return error(502, `Identity commit failed: ${result.identity_reason}`);
		}

		return new Response(JSON.stringify(result), {
			headers: { 'Content-Type': 'application/json' },
			status: 200,
		});
	} catch (err) {
		if (err instanceof ClosetMatchNotFoundError) {
			return error(404, err.message);
		}
		if (err instanceof ClosetMatchResolvedError) {
			return error(409, err.message);
		}
		logRouteError(request.log, 'resolve_closet_match_failed', err);
		if (err instanceof Error) {
			return error(400, err.message);
		}
		return error(500, 'Internal Server Error');
	}
};

export default resolveClosetMatchHandler;
