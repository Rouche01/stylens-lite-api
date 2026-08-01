import { signDownloadUrlForKey } from './assets.utils';
import type { RemoteImage } from './types';
import type { StyleAnalysisEntry, StyleAnalysisHistory } from '../db/types';

/** Sign download URLs for unique keys in parallel. */
export async function resignUrlMap(keys: Array<string | null | undefined>): Promise<Map<string, string>> {
	const unique = [...new Set(keys.filter((k): k is string => typeof k === 'string' && k.length > 0))];
	const entries = await Promise.all(
		unique.map(async (key) => [key, await signDownloadUrlForKey(key)] as const)
	);
	return new Map(entries);
}

/** Fresh cover URLs for session list / favourites payloads. */
export async function resignSessionCovers(
	sessions: StyleAnalysisHistory[]
): Promise<StyleAnalysisHistory[]> {
	const map = await resignUrlMap(sessions.map((s) => s.image_key));
	return sessions.map((s) => {
		if (!s.image_key || !map.has(s.image_key)) return s;
		return { ...s, image_url: map.get(s.image_key)! };
	});
}

/** Fresh URLs for message image arrays + legacy image_url fields. */
export async function resignMessageImages(
	messages: StyleAnalysisEntry[]
): Promise<StyleAnalysisEntry[]> {
	const keys: string[] = [];
	for (const m of messages) {
		if (m.image_key) keys.push(m.image_key);
		for (const img of m.images || []) {
			if (img.key) keys.push(img.key);
		}
	}

	const map = await resignUrlMap(keys);

	return messages.map((m) => {
		const images: RemoteImage[] = (m.images || []).map((img) => {
			if (!img.key || !map.has(img.key)) return img;
			return { ...img, url: map.get(img.key)! };
		});

		const image_url =
			m.image_key && map.has(m.image_key) ? map.get(m.image_key)! : m.image_url;

		return { ...m, images, image_url };
	});
}
