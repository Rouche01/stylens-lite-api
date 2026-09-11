/**
 * Catalog search query from extract attributes.
 * Prefer color + subcategory ("olive jacket"), not fashion labels ("olive green overshirt").
 */
export function buildCatalogQuery(params: {
	color?: string;
	subcategory?: string;
	pattern?: string;
	label?: string;
}): string {
	const color = params.color?.trim().toLowerCase();
	const subcategory = params.subcategory?.trim().toLowerCase().replace(/-/g, ' ');
	const pattern = params.pattern?.trim().toLowerCase();
	const parts: string[] = [];

	if (color) parts.push(color);
	if (pattern && pattern !== 'solid' && pattern !== 'other') parts.push(pattern);
	if (subcategory) parts.push(subcategory);

	const query = parts.join(' ').replace(/\s+/g, ' ').trim();
	if (query) return query;

	return (params.label || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
