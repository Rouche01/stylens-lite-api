import type { FalUseCase } from './falClient';

export type FalModelRef = {
	/** Full `https://fal.run/...` URL. */
	endpoint: string;
	/** Fal model id for logs / dashboards. */
	model: string;
	/** Spend / latency bucket used by {@link falPostJson}. */
	useCase: FalUseCase;
};

const FAL_RUN = 'https://fal.run';

/**
 * Canonical Fal model registry for this Worker.
 * Adapters import from here — do not scatter `fal.run` URLs in call sites.
 */
export const FAL_MODELS = {
	grounding: {
		endpoint: `${FAL_RUN}/fal-ai/florence-2-large/caption-to-phrase-grounding`,
		model: 'fal-ai/florence-2-large/caption-to-phrase-grounding',
		useCase: 'grounding',
	},
	segmentSam2: {
		endpoint: `${FAL_RUN}/fal-ai/sam2/image`,
		model: 'fal-ai/sam2/image',
		useCase: 'segment',
	},
	segmentSam3: {
		endpoint: `${FAL_RUN}/fal-ai/sam-3/image`,
		model: 'fal-ai/sam-3/image',
		useCase: 'segment',
	},
	matte: {
		endpoint: `${FAL_RUN}/fal-ai/birefnet/v2`,
		model: 'fal-ai/birefnet/v2',
		useCase: 'matte',
	},
	packshot: {
		endpoint: `${FAL_RUN}/fal-ai/nano-banana/edit`,
		model: 'fal-ai/nano-banana/edit',
		useCase: 'packshot',
	},
	tryon: {
		endpoint: `${FAL_RUN}/fal-ai/fashn/tryon/v1.6`,
		model: 'fal-ai/fashn/tryon/v1.6',
		useCase: 'tryon',
	},
} as const satisfies Record<string, FalModelRef>;

export type FalModelKey = keyof typeof FAL_MODELS;

/** Convenience aliases used in logs / UI copy. */
export const FAL_SAM2_MODEL = FAL_MODELS.segmentSam2.model;
export const FAL_SAM3_MODEL = FAL_MODELS.segmentSam3.model;
export const FAL_PACKSHOT_MODEL = FAL_MODELS.packshot.model;
export const FAL_TRYON_MODEL = FAL_MODELS.tryon.model;
