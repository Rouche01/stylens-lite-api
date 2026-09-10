const AVATAR_FRAMING_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		is_full_body: {
			type: 'boolean',
			description: 'True only when one standing person is visible head to toe, including feet',
		},
		confidence: {
			type: 'string',
			enum: ['high', 'medium', 'low'],
		},
		reason: {
			type: 'string',
			description: 'Short explanation of the framing decision',
		},
	},
	required: ['is_full_body', 'confidence', 'reason'],
};

export const AVATAR_FRAMING_RESPONSE_FORMAT = {
	type: 'json_schema' as const,
	name: 'AvatarFramingResponse',
	schema: AVATAR_FRAMING_SCHEMA,
};
