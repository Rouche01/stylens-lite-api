import { env } from 'cloudflare:workers';
import { SegmentProvider } from './base.provider';
import { FalSegmentProvider } from './fal.provider';

export function createSegmentProvider(envBindings: Env = env): SegmentProvider {
	const name = (envBindings.SAM_SEGMENT_PROVIDER || 'fal').toLowerCase();

	switch (name) {
		case 'fal':
			return new FalSegmentProvider(envBindings.FAL_KEY);
		default:
			throw new Error(`Unsupported SAM_SEGMENT_PROVIDER: ${name}`);
	}
}

export type { SegmentProvider, SegmentBoxResult, BoxPx, SegmentBoxInput } from './base.provider';
export { SegmentError } from './base.provider';
export { FalSegmentProvider } from './fal.provider';
