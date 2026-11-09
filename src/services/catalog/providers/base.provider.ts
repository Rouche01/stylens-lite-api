export type CatalogHit = {
	imageUrl: string;
	title: string;
	source: string;
	engine: 'google_lens' | 'google_shopping';
};

export type CatalogSearchInput = {
	/** Public URL of the bbox crop (signed R2). Required for Lens. */
	imageUrl?: string;
	/** Short query e.g. "olive jacket". */
	query: string;
};

export class CatalogSearchError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'CatalogSearchError';
	}

	get isRetryable(): boolean {
		if (this.status === 500) return false;
		return this.status == null || this.status === 429 || this.status >= 502;
	}
}

export interface CatalogSearchProvider {
	readonly name: string;

	searchSimilar(input: CatalogSearchInput): Promise<CatalogHit[]>;
}
