import { error } from 'itty-router';
import { IdentityEmbedError } from 'services/identity';
import type { PercentBox } from 'utils/bounding_box';

export type IdentityCropBody = {
	imageKey?: string;
	boundingBox?: {
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
	id?: string;
	userId?: string;
	category?: string;
	closetItemId?: string;
	topK?: number;
};

export function parsePercentBox(box: IdentityCropBody['boundingBox']): PercentBox | undefined {
	if (box == null) return undefined;
	if (
		typeof box.x !== 'number' ||
		typeof box.y !== 'number' ||
		typeof box.width !== 'number' ||
		typeof box.height !== 'number' ||
		box.width <= 0 ||
		box.height <= 0
	) {
		return undefined;
	}
	return { x: box.x, y: box.y, width: box.width, height: box.height };
}

export function parseIdentityCrop(body: IdentityCropBody):
	| { imageKey: string; boundingBox: PercentBox }
	| { error: string } {
	const imageKey = body.imageKey?.trim();
	const boundingBox = parsePercentBox(body.boundingBox);
	if (!imageKey) {
		return { error: 'imageKey is required' };
	}
	if (!boundingBox) {
		return { error: 'boundingBox must include numeric x, y, width, height (percents 0-100)' };
	}
	return { imageKey, boundingBox };
}

export function identityRouteError(err: unknown, jsonHint: string) {
	if (err instanceof SyntaxError) {
		return error(400, jsonHint);
	}
	if (err instanceof IdentityEmbedError) {
		return error(err.status, err.message);
	}
	if (err instanceof Error) {
		return error(400, err.message);
	}
	return error(500, 'Internal Server Error');
}
