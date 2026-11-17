export type BoxPx = [number, number, number, number];

export type SegmentBoxInput = {
	image: ArrayBuffer;
	boxPx?: BoxPx;
	/** Prefer this when the provider can fetch a URL (avoids huge data URIs). */
	imageUrl?: string;
	/** Extract label e.g. "olive green overshirt". Routes Fal to SAM 3 (concept; box optional). */
	label?: string;
	/**
	 * Face / crop path: try SAM 2 box (+ center point) before SAM 3 text.
	 * Wrong non-empty SAM 3 masks no longer skip the box path.
	 */
	preferBoxFirst?: boolean;
	/** Caller abort (e.g. request.signal); composed with Fal use-case timeout. */
	signal?: AbortSignal;
};

export type SegmentBoxResult = {
	pngBytes: Uint8Array;
	model: string;
	/** SAM 3 concept that produced the mask; empty for SAM 2. */
	promptUsed?: string;
	promptsTried?: string[];
	/** Best Fal mask score when `include_scores` was requested (0–1). */
	maskScore?: number;
};

export class SegmentError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'SegmentError';
	}

	get isRetryable(): boolean {
		return this.status == null || this.status === 429 || this.status >= 500;
	}
}

export interface SegmentProvider {
	readonly name: string;
	readonly model: string;

	segmentBox(input: SegmentBoxInput): Promise<SegmentBoxResult>;
}
