import { describe, it, expect } from 'vitest';
import { buildCatalogQuery } from '../src/services/catalog/catalog_query';
import { rankCatalogHits } from '../src/services/catalog/providers/serpapi.provider';

describe('buildCatalogQuery', () => {
	it('uses color and subcategory, not the fashion label', () => {
		expect(
			buildCatalogQuery({
				color: 'olive',
				subcategory: 'jacket',
				label: 'olive green overshirt',
			})
		).toBe('olive jacket');
	});

	it('includes non-solid pattern', () => {
		expect(
			buildCatalogQuery({
				color: 'black',
				subcategory: 't-shirt',
				pattern: 'striped',
			})
		).toBe('black striped t shirt');
	});

	it('falls back to label when attributes are missing', () => {
		expect(buildCatalogQuery({ label: 'olive green overshirt' })).toBe('olive green overshirt');
	});
});

describe('rankCatalogHits', () => {
	it('puts social/street sources after retailer-like hits', () => {
		const ranked = rankCatalogHits([
			{
				imageUrl: 'https://i.pinimg.com/a.jpg',
				title: 'fit',
				source: 'Pinterest',
				engine: 'google_lens',
			},
			{
				imageUrl: 'https://cdn.shop.example/jacket.jpg',
				title: 'Olive jacket',
				source: 'Example Shop',
				engine: 'google_lens',
			},
		]);
		expect(ranked[0].source).toBe('Example Shop');
	});
});
