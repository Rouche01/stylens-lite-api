import { getImageMimeType } from '../../../utils/image.utils';
import { AVATAR_TWIN_EDIT_PROMPT } from '../../../llm/prompts/avatar_generation';
import { AvatarImageError, AvatarImageProvider, GenerateTwinResult } from './base.provider';

function extensionForMime(mimeType: string): string {
	if (mimeType === 'image/png') return 'png';
	if (mimeType === 'image/webp') return 'webp';
	return 'jpg';
}

function decodeBase64(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/**
 * OpenAI Images adapter. AvatarService must not import this directly —
 * resolve via createAvatarImageProvider().
 */
export class OpenAIAvatarImageProvider implements AvatarImageProvider {
	readonly name = 'openai';

	constructor(
		private endpoint: string,
		private apiKey: string,
		readonly model: string
	) {}

	async generateTwin(imageBuffer: ArrayBuffer): Promise<GenerateTwinResult> {
		const mimeType = getImageMimeType(imageBuffer);
		const form = new FormData();
		form.append('image', new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), `source.${extensionForMime(mimeType)}`);
		form.append('model', this.model);
		form.append('prompt', AVATAR_TWIN_EDIT_PROMPT);
		form.append('size', '1024x1536');
		form.append('quality', 'high');

		const response = await fetch(`${this.endpoint.replace(/\/$/, '')}/images/edits`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: form,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => '');
			throw new AvatarImageError(
				`OpenAI images.edit failed (${response.status}): ${body.slice(0, 500)}`,
				response.status
			);
		}

		const json = (await response.json()) as { data?: Array<{ b64_json?: string }> };
		const b64 = json.data?.[0]?.b64_json;
		if (!b64) {
			throw new AvatarImageError('OpenAI images.edit returned no b64_json image');
		}

		return {
			pngBytes: decodeBase64(b64),
			model: this.model,
		};
	}
}
