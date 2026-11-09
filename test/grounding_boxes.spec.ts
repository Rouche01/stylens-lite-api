import { describe, it, expect } from 'vitest';
import { collectGroundingBoxes, pickGroundedPercentBox } from '../src/services/grounding/boxes';

describe('collectGroundingBoxes', () => {
	it('reads florence-style xywh objects', () => {
		const boxes = collectGroundingBoxes({
			results: {
				bboxes: [{ x: 100, y: 200, width: 50, height: 80, score: 0.9, label: 'hat' }],
			},
		});
		expect(boxes).toEqual([{ x: 100, y: 200, width: 50, height: 80, score: 0.9, label: 'hat' }]);
	});

	it('reads xyxy arrays', () => {
		const boxes = collectGroundingBoxes({ boxes: [[100, 200, 200, 320]] });
		expect(boxes[0]).toMatchObject({ x: 100, y: 200, width: 100, height: 120 });
	});
});

describe('pickGroundedPercentBox', () => {
	it('converts pixels and prefers higher score over giant boxes', () => {
		const picked = pickGroundedPercentBox(
			[
				{ x: 0, y: 0, width: 1350, height: 1800, score: 0.99 },
				{ x: 270, y: 450, width: 270, height: 360, score: 0.8 },
			],
			1350,
			1800
		);
		expect(picked?.box).toEqual({ x: 20, y: 25, width: 20, height: 20 });
	});
});
