import { env } from 'cloudflare:workers';
import { CatalogSearchProvider } from './base.provider';
import { SerpApiCatalogProvider } from './serpapi.provider';

export function createCatalogSearchProvider(envBindings: Env = env): CatalogSearchProvider {
	const name = (envBindings.CATALOG_SEARCH_PROVIDER || 'serpapi').toLowerCase();

	switch (name) {
		case 'serpapi':
			return new SerpApiCatalogProvider(envBindings.SERPAPI_API_KEY);
		default:
			throw new Error(`Unsupported CATALOG_SEARCH_PROVIDER: ${name}`);
	}
}

export type { CatalogSearchProvider, CatalogHit, CatalogSearchInput } from './base.provider';
export { CatalogSearchError } from './base.provider';
export { SerpApiCatalogProvider, rankCatalogHits } from './serpapi.provider';
