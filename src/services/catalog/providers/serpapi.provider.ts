import { CatalogHit, CatalogSearchError, CatalogSearchInput, CatalogSearchProvider } from './base.provider';

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';
const STREET_SOURCE = /pinterest|instagram|tiktok|facebook|twitter|x\.com|reddit|tumblr/i;

type SerpRow = {
	title?: string;
	source?: string;
	image?: string;
	thumbnail?: string;
	link?: string;
};

type SerpEnvelope = {
	error?: string;
	visual_matches?: SerpRow[];
	products?: SerpRow[];
	shopping_results?: SerpRow[];
};

function rowImageUrl(row: SerpRow): string | undefined {
	const url = row.image || row.thumbnail;
	if (typeof url === 'string' && url.startsWith('http')) return url;
	return undefined;
}

function rowsToHits(rows: SerpRow[] | undefined, engine: CatalogHit['engine']): CatalogHit[] {
	if (!rows?.length) return [];
	const hits: CatalogHit[] = [];
	for (const row of rows) {
		const imageUrl = rowImageUrl(row);
		if (!imageUrl) continue;
		hits.push({
			imageUrl,
			title: (row.title || '').trim(),
			source: (row.source || row.link || '').trim(),
			engine,
		});
	}
	return hits;
}

/** Prefer retailer/product hits over social street photos. */
export function rankCatalogHits(hits: CatalogHit[]): CatalogHit[] {
	const preferred: CatalogHit[] = [];
	const rest: CatalogHit[] = [];
	for (const hit of hits) {
		const blob = `${hit.source} ${hit.title}`;
		if (STREET_SOURCE.test(blob)) rest.push(hit);
		else preferred.push(hit);
	}
	return preferred.concat(rest);
}

export class SerpApiCatalogProvider implements CatalogSearchProvider {
	readonly name = 'serpapi';

	constructor(private apiKey: string) {}

	async searchSimilar(input: CatalogSearchInput): Promise<CatalogHit[]> {
		const apiKey = this.apiKey?.trim();
		if (!apiKey) {
			throw new CatalogSearchError(
				'SERPAPI_API_KEY is not set. Add it to .dev.vars and fully restart wrangler (hot reload does not pick up new secrets).',
				500
			);
		}

		if (input.imageUrl) {
			const lensHits = await this.googleLensProducts(input.imageUrl, input.query, apiKey);
			if (lensHits.length > 0) return rankCatalogHits(lensHits);
		}

		if (!input.query) {
			return [];
		}

		return rankCatalogHits(await this.googleShopping(input.query, apiKey));
	}

	private async googleLensProducts(imageUrl: string, query: string, apiKey: string): Promise<CatalogHit[]> {
		const url = new URL(SERPAPI_ENDPOINT);
		url.searchParams.set('engine', 'google_lens');
		url.searchParams.set('type', 'products');
		url.searchParams.set('url', imageUrl);
		url.searchParams.set('api_key', apiKey);
		url.searchParams.set('hl', 'en');
		if (query) url.searchParams.set('q', query);

		const json = await this.getJson(url);
		return [
			...rowsToHits(json.products, 'google_lens'),
			...rowsToHits(json.visual_matches, 'google_lens'),
		];
	}

	private async googleShopping(query: string, apiKey: string): Promise<CatalogHit[]> {
		const url = new URL(SERPAPI_ENDPOINT);
		url.searchParams.set('engine', 'google_shopping');
		url.searchParams.set('q', query);
		url.searchParams.set('api_key', apiKey);
		url.searchParams.set('hl', 'en');
		url.searchParams.set('gl', 'us');

		const json = await this.getJson(url);
		return rowsToHits(json.shopping_results, 'google_shopping');
	}

	private async getJson(url: URL): Promise<SerpEnvelope> {
		const response = await fetch(url.toString(), { method: 'GET' });
		const body = await response.text();
		let json: SerpEnvelope = {};
		try {
			json = JSON.parse(body) as SerpEnvelope;
		} catch {
			throw new CatalogSearchError(`SerpAPI returned unparseable body (${response.status})`, response.status);
		}

		if (!response.ok) {
			throw new CatalogSearchError(
				`SerpAPI failed (${response.status}): ${(json.error || body).toString().slice(0, 400)}`,
				response.status
			);
		}
		if (json.error) {
			throw new CatalogSearchError(`SerpAPI error: ${json.error}`, 502);
		}
		return json;
	}
}
