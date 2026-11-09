/**
 * SAM 3 is Promptable Concept Segmentation: short noun phrases (noun + optional
 * modifiers), e.g. "yellow school bus", "red apple". Extract labels like
 * "olive green overshirt" are fashion jargon; the presence head returns empty
 * masks when the concept is not recognized.
 *
 * @see https://ai.meta.com/research/publications/sam-3-segment-anything-with-concepts/
 * @see https://fal.ai/models/fal-ai/sam-3/image
 */

const FILLER = new Set(['a', 'an', 'the', 'with', 'and', 'of', 'in', 'on']);

const COLORS = [
	'olive',
	'green',
	'black',
	'white',
	'grey',
	'gray',
	'navy',
	'blue',
	'red',
	'brown',
	'beige',
	'khaki',
	'cream',
	'pink',
	'purple',
	'yellow',
	'orange',
	'gold',
	'silver',
	'tan',
	'maroon',
	'burgundy',
	'teal',
	'ivory',
	'charcoal',
	'sage',
	'forest',
	'mint',
	'camel',
	'cream',
] as const;

/** Fashion / extract jargon → SAM 3 visual nouns. Longer keys first. */
const GARMENT_SYNONYMS: Array<[string, string]> = [
	['baseball cap', 'hat'],
	['button-up', 'shirt'],
	['button up', 'shirt'],
	['button-down', 'shirt'],
	['button down', 'shirt'],
	['over-shirt', 'jacket'],
	['base layer', 't-shirt'],
	['under shirt', 't-shirt'],
	['undershirt', 't-shirt'],
	['overshirt', 'jacket'],
	['shacket', 'jacket'],
	['buttonup', 'shirt'],
	['tshirt', 't-shirt'],
	['blouse', 'shirt'],
	['henley', 'shirt'],
	['flannel', 'shirt'],
	['oxford', 'shirt'],
	['jumper', 'sweater'],
	['trainers', 'sneakers'],
	['trousers', 'pants'],
	['beanie', 'hat'],
	['kicks', 'sneakers'],
	['cap', 'hat'],
	['tee', 't-shirt'],
	['base', 't-shirt'],
];

function normalize(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[_/]+/g, ' ')
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, ' ');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applySynonyms(phrase: string): string {
	let mapped = phrase;
	for (const [from, to] of GARMENT_SYNONYMS) {
		mapped = mapped.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to);
	}
	return mapped.replace(/\s+/g, ' ').trim();
}

function dropFillers(phrase: string): string {
	return phrase
		.split(' ')
		.filter((token) => token.length > 0 && !FILLER.has(token))
		.join(' ');
}

function addUnique(out: string[], phrase: string) {
	const trimmed = phrase.trim();
	if (trimmed && !out.includes(trimmed)) out.push(trimmed);
}

/**
 * Up to 3 Fal-safe concept prompts, most specific first.
 * Never returns empty when `label` has a token.
 */
export function sam3PromptCandidates(label: string): string[] {
	const raw = dropFillers(normalize(label));
	if (!raw) return [];

	const mapped = applySynonyms(raw);
	const tokens = mapped.split(' ').filter(Boolean);
	const noun = tokens[tokens.length - 1] || mapped;
	const colorSet = new Set<string>(COLORS);
	const color = tokens.find((token) => colorSet.has(token));

	const out: string[] = [];
	addUnique(out, mapped);
	if (color && noun && color !== noun) addUnique(out, `${color} ${noun}`);
	addUnique(out, noun);
	addUnique(out, raw);

	return out.slice(0, 3);
}
