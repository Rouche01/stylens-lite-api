export type GenerateTwinResult = {
	pngBytes: Uint8Array;
	model: string;
};

export class AvatarImageError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'AvatarImageError';
	}

	get isRetryable(): boolean {
		return this.status == null || this.status === 429 || this.status >= 500;
	}
}

export interface AvatarImageProvider {
	readonly name: string;
	readonly model: string;

	generateTwin(imageBuffer: ArrayBuffer): Promise<GenerateTwinResult>;
}
