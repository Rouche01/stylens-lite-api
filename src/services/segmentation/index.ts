export { createCutoutService, CutoutService, percentBoxToPaddedXyxy } from './cutout.svc';
export type {
	CutoutFromR2Params,
	CutoutResult,
	FaceCutoutFromR2Params,
	FaceCutoutResult,
	PercentBox,
} from './cutout.svc';
export {
	createSegmentProvider,
	SegmentError,
	type SegmentProvider,
	type SegmentBoxResult,
	type BoxPx,
} from './providers';
export {
	evaluateFaceCutoutPng,
	evaluateFaceRgba,
	faceCutoutPad,
	facePrefersSam3First,
	faceQualityRank,
	passesFaceQuality,
	type FaceQualityMetrics,
	type FaceQualityVerdict,
} from './face_quality';
export { falBirefnetMatte } from './providers/fal_birefnet';
export {
	falNanoBananaFlatlay,
	flatlayPromptForGarment,
	flatlayPromptForLabel,
	type FlatlayPromptOptions,
} from './providers/fal_nano_banana_flatlay';
