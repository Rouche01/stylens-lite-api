/**
 * Local review-loop artifacts: one JSON file per identity_run_id.
 *
 * Workers cannot write the host filesystem. When ENV_NAME is `dev`, we POST the
 * artifact to a localhost sink (`scripts/identity-run-sink.mjs`) which writes
 * `.cursor/identity_runs/<identity_run_id>.json`. Fail-open if the sink is down.
 */

import type { Logger } from '../../../utils/logger.utils';
import type { IdentityRunItemLogRow, IdentityRunItemSummary } from './runLogging';

export const IDENTITY_RUN_SINK_DEFAULT_URL = 'http://127.0.0.1:8799/identity-runs';

export type IdentityRunArtifactSource = 'queue' | 'extract';

export type IdentityRunArtifact = {
	identity_run_id: string;
	recorded_at: string;
	env: string;
	source: IdentityRunArtifactSource;
	user_id: string;
	image_key: string;
	outfit_id: string;
	session_id: string | null;
	entry_id: string | null;
	item_count: number;
	created: number;
	asked: number;
	failed: number;
	existing_crop: number;
	items_truncated: boolean;
	items: IdentityRunItemLogRow[];
	/** Present so the review loop can flip this after human labeling. */
	reviewed: boolean;
};

export function buildIdentityRunArtifact(params: {
	identity_run_id: string;
	envName: string;
	source: IdentityRunArtifactSource;
	user_id: string;
	image_key: string;
	outfit_id: string;
	summary: IdentityRunItemSummary;
	session_id?: string;
	entry_id?: string;
	recorded_at?: string;
}): IdentityRunArtifact {
	return {
		identity_run_id: params.identity_run_id,
		recorded_at: params.recorded_at ?? new Date().toISOString(),
		env: params.envName,
		source: params.source,
		user_id: params.user_id,
		image_key: params.image_key,
		outfit_id: params.outfit_id,
		session_id: params.session_id?.trim() || null,
		entry_id: params.entry_id?.trim() || null,
		item_count: params.summary.item_count,
		created: params.summary.created,
		asked: params.summary.asked,
		failed: params.summary.failed,
		existing_crop: params.summary.existing_crop,
		items_truncated: params.summary.items_truncated,
		items: params.summary.items,
		reviewed: false,
	};
}

export function shouldPersistIdentityRunArtifact(envName: string): boolean {
	return envName.trim() === 'dev';
}

/**
 * POST artifact to the local sink. No-op outside ENV_NAME=dev. Never throws.
 */
export async function persistIdentityRunArtifact(params: {
	envName: string;
	artifact: IdentityRunArtifact;
	log?: Logger;
	sinkUrl?: string;
	fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; reason?: string }> {
	if (!shouldPersistIdentityRunArtifact(params.envName)) {
		return { ok: false, reason: 'env_not_dev' };
	}

	const url = params.sinkUrl?.trim() || IDENTITY_RUN_SINK_DEFAULT_URL;
	const doFetch = params.fetchImpl ?? fetch;

	try {
		const res = await doFetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(params.artifact),
		});
		if (!res.ok) {
			params.log?.debug('identity_run_artifact_sink_http_error', {
				identity_run_id: params.artifact.identity_run_id,
				status: res.status,
			});
			return { ok: false, reason: `http_${res.status}` };
		}
		params.log?.debug('identity_run_artifact_persisted', {
			identity_run_id: params.artifact.identity_run_id,
			sink_url: url,
		});
		return { ok: true };
	} catch (err) {
		params.log?.debug('identity_run_artifact_sink_unreachable', {
			identity_run_id: params.artifact.identity_run_id,
			sink_url: url,
			error_message: err instanceof Error ? err.message : String(err),
		});
		return { ok: false, reason: 'unreachable' };
	}
}
