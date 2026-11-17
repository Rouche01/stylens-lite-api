import { describe, expect, it } from 'vitest';
import { garmentFaceEnqueuePlan } from '../src/services/closet_face';
import { usesGenerativePackshot } from '../src/services/segmentation';

describe('garmentFaceEnqueuePlan', () => {
	it('defers packshot until after cutout when both flags are on', () => {
		expect(
			garmentFaceEnqueuePlan({ cutoutEnabled: true, packshotEnabled: true })
		).toBe('cutout_then_packshot');
	});

	it('enqueues packshot only when cutout is off', () => {
		expect(
			garmentFaceEnqueuePlan({ cutoutEnabled: false, packshotEnabled: true })
		).toBe('packshot');
	});

	it('enqueues cutout only when packshot is off', () => {
		expect(
			garmentFaceEnqueuePlan({ cutoutEnabled: true, packshotEnabled: false })
		).toBe('cutout');
	});

	it('enqueues nothing when both flags are off', () => {
		expect(
			garmentFaceEnqueuePlan({ cutoutEnabled: false, packshotEnabled: false })
		).toBe('none');
	});
});

describe('footwear packshot path', () => {
	it('keeps footwear on the dedicated path (not apparel generative enqueue)', () => {
		expect(usesGenerativePackshot('footwear')).toBe(false);
		expect(usesGenerativePackshot('bottom')).toBe(true);
	});
});
