import type { RemoteImage } from './types';
import type { StyleAnalysisEntry, StyleAnalysisHistory } from '../db/types';

/** Absolute proxy URL for an R2 object key (client fetches with Bearer auth). */
export function assetProxyUrl(origin: string, key: string): string {
	const base = origin.replace(/\/$/, '');
	return `${base}/assets/file?key=${encodeURIComponent(key)}`;
}

/** Rewrite session cover URLs to the authenticated asset proxy. */
export function rewriteSessionCoversToProxy(
	sessions: StyleAnalysisHistory[],
	origin: string
): StyleAnalysisHistory[] {
	return sessions.map((s) => {
		if (!s.image_key) return s;
		return { ...s, image_url: assetProxyUrl(origin, s.image_key) };
	});
}

/** Rewrite message image URLs to the authenticated asset proxy. */
export function rewriteMessageImagesToProxy(
	messages: StyleAnalysisEntry[],
	origin: string
): StyleAnalysisEntry[] {
	return messages.map((m) => {
		const images: RemoteImage[] = (m.images || []).map((img) => {
			if (!img.key) return img;
			return { ...img, url: assetProxyUrl(origin, img.key) };
		});

		const image_url = m.image_key ? assetProxyUrl(origin, m.image_key) : m.image_url;

		return { ...m, images, image_url };
	});
}
