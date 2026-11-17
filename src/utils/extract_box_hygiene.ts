import { identityEmbedBox, percentBoxIou, type PercentBox } from './bounding_box';

/** Near-identical crops after Florence often collapse layered garments onto one box. */
export const EXTRACT_BOX_DEDUPE_IOU = 0.85;

/**
 * Two tops with this much IoU are treated as the same torso layer fight
 * (hem-peek “gray band” under a hoodie lands ~0.55 after Florence).
 */
export const EXTRACT_TOP_LAYER_IOU = 0.45;

/**
 * Accessories that are large enough / identity-useful to extract for now.
 * Everything else (socks, eyewear, belt, scarf, jewelry, watch, gloves, other) is dropped.
 */
export const EXTRACT_ACCESSORY_KEEP = new Set(['bag', 'hat', 'cap']);

export type ExtractHygieneItem = {
	label?: string;
	category: string;
	subcategory?: string;
	confidence?: string;
	bounding_box: PercentBox;
};

/** Area as % of the frame (width% × height% / 100). */
export function extractBoxAreaPercent(box: PercentBox): number {
	return (box.width * box.height) / 100;
}

function normalizeSubcategory(subcategory?: string): string {
	return subcategory?.trim().toLowerCase() ?? '';
}

/** True when an accessory subcategory is on the v1 keep allowlist (bag / hat / cap). */
export function isKeptExtractAccessory(subcategory?: string): boolean {
	return EXTRACT_ACCESSORY_KEEP.has(normalizeSubcategory(subcategory));
}

function maxAreaPercent(category: string): number {
	switch (category) {
		case 'footwear':
			return 8;
		case 'accessory':
			return 22;
		case 'top':
			return 18;
		case 'outerwear':
			return 28;
		case 'bottom':
			return 32;
		case 'full-body':
			return 55;
		default:
			return 40;
	}
}

function maxHeightPercent(category: string, subcategory?: string): number {
	const sub = normalizeSubcategory(subcategory);
	switch (category) {
		case 'footwear':
			return 22;
		case 'accessory':
			if (sub === 'hat' || sub === 'cap') return 18;
			return 50;
		case 'top':
			return 42;
		case 'outerwear':
			return 52;
		case 'bottom':
			return 55;
		case 'full-body':
			return 85;
		default:
			return 70;
	}
}

/**
 * Reject Florence/LLM boxes that swallow most of the torso, fail identity embed
 * mins (after hat expand), or are otherwise too large for the category.
 */
export function isPlausibleExtractBox(item: ExtractHygieneItem): boolean {
	const box = item.bounding_box;
	if (!(box.width > 0) || !(box.height > 0)) return false;
	if (box.height > maxHeightPercent(item.category, item.subcategory)) return false;
	if (extractBoxAreaPercent(box) > maxAreaPercent(item.category)) return false;
	// Align with identity: drop crops that would only create skip_query / unusable tiles.
	if (
		!identityEmbedBox(box, {
			category: item.category,
			subcategory: item.subcategory,
		})
	) {
		return false;
	}
	return true;
}

function confidenceRank(confidence?: string): number {
	if (confidence === 'high') return 3;
	if (confidence === 'medium') return 2;
	if (confidence === 'low') return 1;
	return 0;
}

/** Outer-ish tops beat hem-peek mislabels when Florence collapses both onto the torso. */
function topSubcategoryRank(subcategory?: string): number {
	switch (normalizeSubcategory(subcategory)) {
		case 'hoodie':
			return 10;
		case 'sweatshirt':
		case 'sweater':
			return 6;
		case 'shirt':
		case 'polo':
			return 5;
		case 't-shirt':
			return 4;
		case 'tank-top':
		case 'crop-top':
			return 3;
		default:
			return 2;
	}
}

/**
 * LLM sometimes invents a garment from an undershirt hem ("gray band").
 * Drop those labels before they become closet tiles / packshots.
 */
export function isJunkPeekExtractLabel(label?: string): boolean {
	const text = label?.trim().toLowerCase() ?? '';
	if (!text) return false;
	if (/\b(waistband|hem|sliver|peek)\b/.test(text)) return true;
	if (/\bstrips?\b/.test(text)) return true;
	// "gray band" / "band" — keep headband/sweatband/wristband for accessory path (usually dropped).
	if (/\bbands?\b/.test(text) && !/\b(head|sweat|wrist)bands?\b/.test(text)) return true;
	return false;
}

/** Higher wins when two items share nearly the same crop. */
export function extractItemKeepScore(item: ExtractHygieneItem): number {
	const subcategory = normalizeSubcategory(item.subcategory);
	let categoryScore = 20;
	switch (item.category) {
		case 'outerwear':
			categoryScore = 50;
			break;
		case 'full-body':
			categoryScore = 48;
			break;
		case 'footwear':
			categoryScore = 45;
			break;
		case 'bottom':
			categoryScore = 40;
			break;
		case 'top':
			categoryScore = 35 + topSubcategoryRank(subcategory);
			break;
		case 'accessory':
			categoryScore = subcategory === 'hat' || subcategory === 'cap' ? 30 : subcategory === 'bag' ? 28 : 10;
			break;
	}
	const areaPenalty = extractBoxAreaPercent(item.bounding_box) / 100;
	return categoryScore * 10 + confidenceRank(item.confidence) * 3 - areaPenalty;
}

function shouldKeepExtractItem(item: ExtractHygieneItem): boolean {
	if (item.category === 'accessory' && !isKeptExtractAccessory(item.subcategory)) {
		return false;
	}
	if (isJunkPeekExtractLabel(item.label)) {
		return false;
	}
	return isPlausibleExtractBox(item);
}

function isTopLayerItem(item: ExtractHygieneItem): boolean {
	return item.category === 'top';
}

/** True when candidate is a dominated torso twin of an already-kept top. */
function isDominatedTopLayer(candidate: ExtractHygieneItem, kept: ExtractHygieneItem): boolean {
	if (!isTopLayerItem(candidate) || !isTopLayerItem(kept)) return false;
	if (percentBoxIou(candidate.bounding_box, kept.bounding_box) < EXTRACT_TOP_LAYER_IOU) return false;
	const candScore = extractItemKeepScore(candidate);
	const keptScore = extractItemKeepScore(kept);
	if (keptScore > candScore) return true;
	if (keptScore < candScore) return false;
	// Tie-break: prefer the already-kept (higher-ranked) outer-ish subcategory.
	return topSubcategoryRank(kept.subcategory) >= topSubcategoryRank(candidate.subcategory);
}

/**
 * Drop minor accessories and absurd boxes, then collapse near-duplicate crops
 * to the preferred item (outerwear over top, etc.). Preserves relative order.
 */
export function sanitizeExtractedItems<T extends ExtractHygieneItem>(items: T[]): T[] {
	const plausible = items
		.map((item, index) => ({ item, index }))
		.filter(({ item }) => shouldKeepExtractItem(item));

	const ranked = [...plausible].sort(
		(a, b) => extractItemKeepScore(b.item) - extractItemKeepScore(a.item) || a.index - b.index
	);

	const winners: Array<{ item: T; index: number }> = [];
	for (const candidate of ranked) {
		const overlaps = winners.some(
			(kept) =>
				percentBoxIou(candidate.item.bounding_box, kept.item.bounding_box) >= EXTRACT_BOX_DEDUPE_IOU ||
				isDominatedTopLayer(candidate.item, kept.item)
		);
		if (overlaps) continue;
		winners.push(candidate);
	}

	return winners.sort((a, b) => a.index - b.index).map(({ item }) => item);
}
