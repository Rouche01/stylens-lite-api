import { describe, expect, it } from 'vitest';
import {
	dailyStyleNudgePayload,
	pickDailyStyleNudgeCopy,
} from '../src/jobs/daily_style_nudge';
import {
	getZonedParts,
	isLocalMorningWindow,
	localDayStartMs,
	zonedLocalToUtcMs,
} from '../src/utils/timezone.utils';

describe('timezone morning window helpers', () => {
	it('computes local day start for UTC', () => {
		const noon = Date.UTC(2026, 8, 24, 12, 0, 0);
		expect(localDayStartMs(noon, 'UTC')).toBe(Date.UTC(2026, 8, 24, 0, 0, 0));
	});

	it('computes local day start for Europe/Amsterdam (CEST, UTC+2)', () => {
		// 2026-09-24 10:00 UTC = 12:00 Amsterdam → local midnight was 22:00 UTC previous day
		const amsterdamNoonUtc = Date.UTC(2026, 8, 24, 10, 0, 0);
		const start = localDayStartMs(amsterdamNoonUtc, 'Europe/Amsterdam');
		const parts = getZonedParts(start, 'Europe/Amsterdam');
		expect(parts).toMatchObject({ year: 2026, month: 9, day: 24, hour: 0, minute: 0, second: 0 });
		expect(start).toBe(zonedLocalToUtcMs(2026, 9, 24, 0, 0, 0, 'Europe/Amsterdam'));
	});

	it('detects morning window hours 8–9 local', () => {
		// 2026-09-24 06:30 UTC = 08:30 Amsterdam (CEST)
		const inWindow = Date.UTC(2026, 8, 24, 6, 30, 0);
		expect(isLocalMorningWindow(inWindow, 'Europe/Amsterdam')).toBe(true);
		expect(isLocalMorningWindow(inWindow, 'UTC')).toBe(false);

		const utcMorning = Date.UTC(2026, 8, 24, 8, 15, 0);
		expect(isLocalMorningWindow(utcMorning, 'UTC')).toBe(true);
		expect(isLocalMorningWindow(utcMorning, 'Europe/Amsterdam')).toBe(false);
	});
});

describe('daily style nudge copy', () => {
	it('picks a stable variant per user/day', () => {
		const a = pickDailyStyleNudgeCopy('user-1', 1000);
		const b = pickDailyStyleNudgeCopy('user-1', 1000);
		expect(a).toEqual(b);
		expect(a.title.length).toBeGreaterThan(0);
		expect(a.body.length).toBeGreaterThan(0);
	});

	it('builds FCM string data payload', () => {
		const payload = dailyStyleNudgePayload({
			title: 'Your stylist',
			body: 'What are you wearing today?',
		});
		expect(payload.data).toEqual({
			type: 'daily_style_nudge',
			link: 'gostylens://capture',
		});
	});
});
