const OUTFIT_EXTRACTION_SCHEMA = {
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

const OUTFIT_EXTRACTION_SCHEMA_V2 = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					label: {
						type: "string",
						description: "Descriptive name of the clothing item e.g. 'black leather bomber jacket'",
					},
					category: {
						type: "string",
						enum: ["top", "bottom", "outerwear", "footwear", "accessory", "full-body"],
						description: "The category of the clothing item",
					},
					color: {
						type: "string",
						description: "Primary color as a plain word e.g. black, navy, olive",
					},
					pattern: {
						type: "string",
						enum: ["solid", "striped", "checked", "graphic", "camo", "floral", "other"],
						description: "The pattern of the clothing item",
					},
					style_tags: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						description: "2-3 style tags e.g. streetwear, casual, formal",
					},
					confidence: {
						type: "string",
						enum: ["high", "low"],
						description: "high if clearly visible, low if partially obscured",
					},
					bounding_box: {
						type: "object",
						properties: {
							x: {
								type: "number",
								description: "Left edge as percentage of image width (0-100)",
							},
							y: {
								type: "number",
								description: "Top edge as percentage of image height (0-100)",
							},
							width: {
								type: "number",
								description: "Item width as percentage of image width (0-100)",
							},
							height: {
								type: "number",
								description: "Item height as percentage of image height (0-100)",
							},
						},
						required: ["x", "y", "width", "height"],
						additionalProperties: false,
					},
				},
				required: [
					"label",
					"category",
					"color",
					"pattern",
					"style_tags",
					"confidence",
					"bounding_box",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["items"],
	additionalProperties: false,
};

export const OUTFIT_EXTRACTION_RESPONSE_FORMAT = {
	type: 'json_schema' as const,
	name: 'OutfitExtractionResponse',
	schema: OUTFIT_EXTRACTION_SCHEMA_V2
};
