import {
	IdentityEmbedError,
	DEFAULT_DINO_EMBED_MODEL,
	DEFAULT_DINO_EMBED_VERSION,
	type EmbedImageInput,
	type ImageEmbedProvider,
	type ImageEmbedResult,
} from '../embed.types';

const REPLICATE_PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions';
/** Scale-to-zero T4 queue has exceeded 4m (query still `starting` at our old cap, then succeeded). */
const WAIT_BUDGET_MS = 480_000;
const POLL_INTERVAL_MS = 2_000;
/** Transient API / network flakes; low Replicate credit throttles to ~6/min. */
const EMBED_ATTEMPTS = 6;
const EMBED_RETRY_BASE_MS = 400;
const THROTTLE_RETRY_FLOOR_MS = 11_000;

function isNumericVector(value: unknown): value is number[] {
	return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** CLS token from HF feature-extraction: `[hidden]`, `[seq, hidden]`, or `[batch, seq, hidden]`. */
export function parseDinoClsEmbedding(json: unknown): number[] {
	if (json && typeof json === 'object' && !Array.isArray(json)) {
		const record = json as Record<string, unknown>;
		if (typeof record.error === 'string' && record.error.trim()) {
			throw new IdentityEmbedError(record.error, 502);
		}
		if ('last_hidden_state' in record) {
			return parseDinoClsEmbedding(record.last_hidden_state);
		}
		if ('embeddings' in record) {
			return parseDinoClsEmbedding(record.embeddings);
		}
		if ('embedding' in record) {
			return parseDinoClsEmbedding(record.embedding);
		}
	}
	if (typeof json === 'string' && json.trim().startsWith('[')) {
		try {
			return parseDinoClsEmbedding(JSON.parse(json) as unknown);
		} catch {
			throw new IdentityEmbedError('DINO response did not include a numeric vector', 502);
		}
	}
	if (isNumericVector(json)) {
		return json;
	}
	if (!Array.isArray(json) || json.length === 0) {
		throw new IdentityEmbedError('DINO response did not include a numeric vector', 502);
	}
	const first = json[0];
	if (isNumericVector(first)) {
		return first;
	}
	return parseDinoClsEmbedding(first);
}

export function l2Normalize(values: number[]): number[] {
	const norm = Math.sqrt(values.reduce((sum, n) => sum + n * n, 0));
	if (!Number.isFinite(norm) || norm === 0) {
		throw new IdentityEmbedError('DINO embedding had zero norm', 502);
	}
	return values.map((n) => n / norm);
}

export type DinoReplicateRef = {
	model: string;
	version: string;
};

export function resolveDinoModel(model?: string): DinoReplicateRef {
	const trimmed = model?.trim();
	if (!trimmed || trimmed.startsWith('facebook/') || trimmed.includes('dinov2')) {
		return { model: DEFAULT_DINO_EMBED_MODEL, version: DEFAULT_DINO_EMBED_VERSION };
	}
	const colon = trimmed.lastIndexOf(':');
	if (colon > 0) {
		const name = trimmed.slice(0, colon).trim();
		const version = trimmed.slice(colon + 1).trim();
		if (name && version) {
			return { model: name, version };
		}
	}
	return { model: trimmed, version: DEFAULT_DINO_EMBED_VERSION };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new DOMException('Aborted', 'AbortError'));
			},
			{ once: true }
		);
	});
}

/**
 * Prefer a fetchable HTTPS URL over a data URI. Smoke failures clustered on large crops where
 * base64 bloated the predictions POST; Replicate can pull the already-signed R2 crop URL.
 */
export function imageToReplicateUri(input: EmbedImageInput, preferBytes = false): string {
	const url = input.imageUrl?.trim();
	if (!preferBytes && url && /^https?:\/\//i.test(url)) {
		return url;
	}
	if (input.imageBytes.byteLength > 0) {
		const type = input.contentType?.trim() || 'image/jpeg';
		return `data:${type};base64,${arrayBufferToBase64(input.imageBytes)}`;
	}
	if (url) {
		return url;
	}
	throw new IdentityEmbedError('DINOv3 embed input had neither imageUrl nor imageBytes', 500);
}

function isRetryableEmbedError(err: unknown): boolean {
	if (err instanceof DOMException && err.name === 'AbortError') {
		return false;
	}
	if (err instanceof IdentityEmbedError) {
		return err.status === 502 || err.status === 504 || err.status === 429;
	}
	return true;
}

function isThrottleEmbedError(err: unknown): boolean {
	return err instanceof IdentityEmbedError && err.status === 429;
}

/** Replicate: "Your rate limit resets in ~4s." */
export function throttleRetryDelayMs(message: string, attempt = 0): number {
	const match = message.match(/resets in ~?(\d+)\s*s/i);
	const resetMs = match ? Number(match[1]) * 1000 + 750 : THROTTLE_RETRY_FLOOR_MS;
	return Math.max(THROTTLE_RETRY_FLOOR_MS, resetMs) + attempt * 2_000;
}

function embedRetryDelayMs(err: unknown, attempt: number): number {
	if (isThrottleEmbedError(err)) {
		const message = err instanceof Error ? err.message : '';
		return throttleRetryDelayMs(message, attempt);
	}
	return EMBED_RETRY_BASE_MS * 2 ** attempt;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
	}
	return btoa(binary);
}

type ReplicatePrediction = {
	id?: string;
	status?: string;
	output?: unknown;
	error?: unknown;
	urls?: { get?: string };
};

function replicateErrorMessage(json: unknown, status: number): string {
	if (json && typeof json === 'object') {
		const record = json as Record<string, unknown>;
		if (typeof record.detail === 'string' && record.detail.trim()) {
			return record.detail;
		}
		if (record.detail != null) {
			return JSON.stringify(record.detail);
		}
		if (typeof record.error === 'string' && record.error.trim()) {
			return record.error;
		}
		if (typeof record.title === 'string' && record.title.trim()) {
			return record.title;
		}
	}
	return `DINOv3 embeddings failed (${status})`;
}

/**
 * Self-supervised vision encoder for garment instance matching.
 * Hugging Face no longer serves DINOv2 on hf-inference. Replicate hosts DINOv3 CLS (1024-d).
 */
export class DinoV3ReplicateEmbedProvider implements ImageEmbedProvider {
	readonly name = 'dinov3';

	constructor(
		private apiKey: string,
		private model: string = DEFAULT_DINO_EMBED_MODEL,
		private version: string = DEFAULT_DINO_EMBED_VERSION
	) {}

	async embedImage(input: EmbedImageInput): Promise<ImageEmbedResult> {
		const apiKey = this.apiKey?.trim();
		if (!apiKey) {
			throw new IdentityEmbedError('REPLICATE_API_TOKEN is not set', 500);
		}

		let lastErr: unknown;
		let lastWasThrottle = false;
		for (let attempt = 0; attempt < EMBED_ATTEMPTS; attempt++) {
			// Bytes fallback only after non-throttle failures (URL fetch / parse issues).
			const preferBytes = attempt > 0 && !lastWasThrottle;
			try {
				return await this.embedImageOnce(apiKey, input, preferBytes);
			} catch (err) {
				lastErr = err;
				lastWasThrottle = isThrottleEmbedError(err);
				if (!isRetryableEmbedError(err) || attempt >= EMBED_ATTEMPTS - 1) {
					throw err;
				}
				await sleep(embedRetryDelayMs(err, attempt), input.signal);
			}
		}
		throw lastErr instanceof Error ? lastErr : new IdentityEmbedError('DINOv3 embed failed', 502);
	}

	private async embedImageOnce(apiKey: string, input: EmbedImageInput, preferBytes: boolean): Promise<ImageEmbedResult> {
		const deadline = Date.now() + WAIT_BUDGET_MS;
		let prediction = (await this.requestJson(
			REPLICATE_PREDICTIONS_URL,
			{
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				Prefer: 'wait',
			},
			JSON.stringify({ version: this.version, input: { image: imageToReplicateUri(input, preferBytes) } }),
			input.signal
		)) as ReplicatePrediction;

		while (Date.now() < deadline) {
			if (prediction.status === 'succeeded' || (prediction.output != null && !prediction.status)) {
				const vector = l2Normalize(await this.parseOutput(prediction.output, input.signal));
				return { model: `${this.model}:${this.version}`, dimensions: vector.length, vector };
			}
			if (prediction.status === 'failed' || prediction.status === 'canceled') {
				throw new IdentityEmbedError(`DINOv3 failed: ${String(prediction.error ?? prediction.status)}`, 502);
			}
			const pollUrl = prediction.urls?.get || (prediction.id ? `https://api.replicate.com/v1/predictions/${prediction.id}` : '');
			if (!pollUrl) {
				break;
			}
			await sleep(POLL_INTERVAL_MS, input.signal);
			prediction = (await this.requestJson(
				pollUrl,
				{ Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
				undefined,
				input.signal,
				'GET'
			)) as ReplicatePrediction;
		}

		throw new IdentityEmbedError(
			`DINOv3 timed out waiting for an embedding (${prediction.status ?? 'unknown'}, id=${prediction.id ?? 'none'})`,
			504
		);
	}

	private async parseOutput(output: unknown, signal?: AbortSignal): Promise<number[]> {
		if (typeof output === 'string' && /^https?:\/\//.test(output.trim())) {
			const response = await fetch(output.trim(), { signal });
			const json: unknown = await response.json().catch(() => null);
			if (!response.ok || json == null) {
				throw new IdentityEmbedError('DINOv3 output file could not be read', 502);
			}
			return parseDinoClsEmbedding(json);
		}
		return parseDinoClsEmbedding(output);
	}

	private async requestJson(
		url: string,
		headers: Record<string, string>,
		body?: string,
		signal?: AbortSignal,
		method = 'POST'
	): Promise<unknown> {
		let response: Response;
		try {
			const init: RequestInit = { method, headers, signal };
			if (body !== undefined) {
				init.body = body;
			}
			response = await fetch(url, init);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'unknown';
			throw new IdentityEmbedError(`DINOv3 request failed: ${message}`, 502);
		}

		const json: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new IdentityEmbedError('Replicate unauthorized — check REPLICATE_API_TOKEN', 502);
			}
			const status = response.status === 429 ? 429 : 502;
			throw new IdentityEmbedError(replicateErrorMessage(json, response.status), status);
		}
		return json;
	}
}
