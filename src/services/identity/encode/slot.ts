import { IdentityEmbedError } from './embed.types';

/** Coarse body region. Used as a Vectorize filter so jeans never rank against jackets. */
export type IdentitySlot = 'upper' | 'lower' | 'full_body' | 'footwear' | 'accessory';

const SLOT_BY_CATEGORY: Record<string, IdentitySlot> = {
	top: 'upper',
	tops: 'upper',
	outerwear: 'upper',
	jacket: 'upper',
	bottom: 'lower',
	bottoms: 'lower',
	pants: 'lower',
	'full-body': 'full_body',
	full_body: 'full_body',
	dress: 'full_body',
	footwear: 'footwear',
	shoes: 'footwear',
	accessory: 'accessory',
};

export function isIdentitySlot(value: string): value is IdentitySlot {
	return (
		value === 'upper' ||
		value === 'lower' ||
		value === 'full_body' ||
		value === 'footwear' ||
		value === 'accessory'
	);
}

export function resolveIdentitySlot(category?: string): IdentitySlot | undefined {
	const key = category?.trim().toLowerCase();
	if (!key) {
		return undefined;
	}
	return SLOT_BY_CATEGORY[key];
}

export function requireIdentitySlot(category: string): IdentitySlot {
	const slot = resolveIdentitySlot(category);
	if (!slot) {
		throw new IdentityEmbedError(
			`Cannot map category "${category}" to an identity slot (upper/lower/full_body/footwear/accessory)`,
			400
		);
	}
	return slot;
}
