const CLASSIFICATION_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		tags: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tag: { type: 'string' },
					payload: {
						type: ['object', 'null'],
						additionalProperties: false,
						properties: {
							occasion: { type: ['string', 'null'] },
							constraint: { type: ['string', 'null'] },
							type: { type: ['string', 'null'] },
							preference: { type: ['string', 'null'] },
							summary: { type: ['string', 'null'] }
						},
						required: ['occasion', 'constraint', 'type', 'preference', 'summary']
					}
				},
				required: ['tag', 'payload']
			}
		}
	},
	required: ['tags']
};

export const CLASSIFICATION_RESPONSE_FORMAT = {
	type: 'json_schema' as const,
	name: 'ClassificationResponse',
	schema: CLASSIFICATION_SCHEMA
};
