export const OUTFIT_EXTRACTION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					category: {
						type: 'string',
						enum: ['outerwear', 'top', 'bottom', 'dress', 'shoes', 'accessories'],
					},
					subcategory: { type: 'string' },
					color: { type: 'string' },
					material: { type: ['string', 'null'] },
					style: {
						type: 'array',
						items: { type: 'string' },
					},
					confidence: {
						type: 'number',
						minimum: 0,
						maximum: 1,
					},
				},
				required: ['category', 'subcategory', 'color', 'material', 'style', 'confidence'],
			},
		},
	},
	required: ['items'],
};
