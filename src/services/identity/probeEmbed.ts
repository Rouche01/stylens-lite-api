import type { ClosetMatchProbeEmbed } from '../../db/closet';
import type { PreparedClosetCrop } from './identity.svc';
import { IDENTITY_ENCODER, VECTORIZE_INDEX_DIMENSIONS } from './embed.types';

/** Pin IDENTITY_ENCODER, not the embedder model name. Null if the vector is unusable. */
export function closetMatchProbeFromPrepared(prepared: PreparedClosetCrop): ClosetMatchProbeEmbed | null {
	if (!Array.isArray(prepared.vector) || prepared.vector.length === 0) {
		return null;
	}
	if (prepared.vector.length !== prepared.dimensions) {
		return null;
	}
	return {
		encoder: IDENTITY_ENCODER,
		dimensions: prepared.dimensions,
		vector: prepared.vector,
		crop_color: prepared.crop_color,
		crop_blur_hash: prepared.crop_blur_hash,
	};
}

/** Hydrate a current-encoder probe; null if missing or stale (caller falls back to prepareClosetCrop). */
export function preparedFromProbeEmbed(
	probe: ClosetMatchProbeEmbed | null | undefined,
	sourceImageKey = ''
): PreparedClosetCrop | null {
	if (!probe) return null;
	if (probe.encoder !== IDENTITY_ENCODER) return null;
	if (probe.dimensions !== VECTORIZE_INDEX_DIMENSIONS) return null;
	if (probe.vector.length !== probe.dimensions) return null;
	return {
		model: IDENTITY_ENCODER,
		dimensions: probe.dimensions,
		index_dimensions: VECTORIZE_INDEX_DIMENSIONS,
		matches_index: true,
		vector_preview: probe.vector.slice(0, 8),
		crop_image_key: '',
		crop_image_url: '',
		crop_width: 0,
		crop_height: 0,
		source_image_key: sourceImageKey,
		crop_color: probe.crop_color,
		crop_blur_hash: probe.crop_blur_hash,
		vector: probe.vector,
	};
}
