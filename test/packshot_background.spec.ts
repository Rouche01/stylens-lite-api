import { describe, expect, it } from 'vitest';
import {
	PACKSHOT_BG_FOR_DARK_GARMENT,
	PACKSHOT_BG_FOR_LIGHT_GARMENT,
	isLightGarmentForPackshotBg,
	resolvePackshotStudioBackground,
} from '../src/utils/packshot_background';

describe('packshot studio background', () => {
	it('uses mint for dark garments (default / black / burgundy)', () => {
		expect(resolvePackshotStudioBackground({ color: 'black' }).hex).toBe(PACKSHOT_BG_FOR_DARK_GARMENT);
		expect(resolvePackshotStudioBackground({ color: 'burgundy' }).hex).toBe(PACKSHOT_BG_FOR_DARK_GARMENT);
		expect(resolvePackshotStudioBackground({}).hex).toBe(PACKSHOT_BG_FOR_DARK_GARMENT);
		expect(resolvePackshotStudioBackground({ color: 'black' }).backdrop).toBe('light');
	});

	it('uses charcoal for light garments (white / cream / light-blue)', () => {
		expect(resolvePackshotStudioBackground({ color: 'white' }).hex).toBe(PACKSHOT_BG_FOR_LIGHT_GARMENT);
		expect(resolvePackshotStudioBackground({ color: 'cream' }).hex).toBe(PACKSHOT_BG_FOR_LIGHT_GARMENT);
		expect(resolvePackshotStudioBackground({ color: 'light-blue' }).hex).toBe(PACKSHOT_BG_FOR_LIGHT_GARMENT);
		expect(resolvePackshotStudioBackground({ color: 'white' }).backdrop).toBe('dark');
	});

	it('prefers mean luma over ambiguous color words', () => {
		expect(isLightGarmentForPackshotBg({ meanLuma: 200 })).toBe(true);
		expect(isLightGarmentForPackshotBg({ meanLuma: 40 })).toBe(false);
		expect(resolvePackshotStudioBackground({ color: 'gray', meanLuma: 180 }).hex).toBe(
			PACKSHOT_BG_FOR_LIGHT_GARMENT
		);
	});

	it('prompt clauses name the locked hex and forbid seams/texture', () => {
		const dark = resolvePackshotStudioBackground({ color: 'navy' });
		expect(dark.promptClause).toContain(PACKSHOT_BG_FOR_DARK_GARMENT);
		expect(dark.promptClause).toMatch(/no floor\/wall seam/i);
		const light = resolvePackshotStudioBackground({ color: 'white' });
		expect(light.promptClause).toContain(PACKSHOT_BG_FOR_LIGHT_GARMENT);
		expect(light.promptClause).toMatch(/charcoal/i);
	});
});
