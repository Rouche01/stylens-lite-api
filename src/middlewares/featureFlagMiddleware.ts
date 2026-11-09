import { RequestHandler } from 'itty-router';
import { AuthRequest, ApiRequest } from 'types';
import { apiError } from 'utils/error';
import { isFeatureFlagEnabledForAuthId } from '../services/featureFlagGate.svc';

export type RequireFeatureFlagOptions = {
	/** Human-readable 404 body. Default: "Feature is unavailable". */
	message?: string;
	/** Machine code without STYLENS_ prefix. Default: FEATURE_UNAVAILABLE. */
	code?: string;
};

export function featureUnavailableResponse(options?: RequireFeatureFlagOptions): Response {
	return apiError(
		404,
		options?.message ?? 'Feature is unavailable',
		options?.code ?? 'FEATURE_UNAVAILABLE'
	);
}

/**
 * After auth: 404 when the flag is off for `request.user.authId`.
 * Admin callers (`request.isAdmin`) skip the check.
 */
export function requireFeatureFlagMiddleware(
	flagKey: string,
	options?: RequireFeatureFlagOptions
): RequestHandler<ApiRequest> {
	return async (request) => {
		if (request.isAdmin) return;

		const authRequest = request as AuthRequest;
		const authId = authRequest.user?.authId;
		if (!(await isFeatureFlagEnabledForAuthId(flagKey, authId))) {
			return featureUnavailableResponse(options);
		}
	};
}
