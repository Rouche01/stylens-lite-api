#!/usr/bin/env node
/**
 * Encoder bake-off on a labeled smoke with crop probes.
 *
 * Offline (no API):
 *   npm run identity:bakeoff
 *   → dinov3-cls from stored identity_probe vectors
 *
 * Re-embed variants (needs REPLICATE_API_TOKEN; caches under tmp/extract_smoke/encoder_cache/):
 *   npm run identity:bakeoff -- --encoders dinov3-cls,dinov3-patch,dinov3-patch-flip
 *
 * OpenCLIP encoders (local venv tmp/bakeoff-venv + open_clip + safetensors):
 *   npm run identity:bakeoff -- --encoders dinov3-cls,fashionsiglip,moda
 *   moda           → HopitAI/moda-fashion-vision-fp16 (768-d; SigLIP base + vision_encoder.safetensors)
 *   moda-distilled → HopitAI/moda-fashion-distilled (768-d full CLIP, open_clip hub)
 *
 * Reports same-vs-different cosine distributions and full decision metrics
 * (identityScore with stored crop_color, soft subcategory gate).
 *
 * Color / ask-floor grid (vectors cached; no re-embed):
 *   npm run identity:bakeoff -- --encoders dinov3-cls,fashionsiglip,moda --sweep
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SMOKE_DIR = join(ROOT, 'tmp/extract_smoke');
const LABELS_PATH = join(SMOKE_DIR, 'labels.json');
const CACHE_DIR = join(SMOKE_DIR, 'encoder_cache');
const DEFAULT_SET = resolve(ROOT, '../outfits-set-v1');
const MANIFEST_PATH = join(process.env.OUTFIT_EVAL_SET || DEFAULT_SET, 'manifest.json');

const COLOR_DISTANCE_FULL_PENALTY = 0.3;
const COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL = 0.3;
const CHROMA_HUE_MIN_S = 0.28;
const IDENTITY_MATCH_MIN = 0.5;
const SUBCATEGORY_FAMILY_PENALTY = 0.85;
const SUBCATEGORY_STRICT_SLOTS = new Set(['accessory', 'footwear']);
const CLOSED_SHOE_SUBCATEGORIES = new Set(['boots', 'sneakers', 'loafers']);

const SLOT_BY_CATEGORY = {
	top: 'upper',
	tops: 'upper',
	outerwear: 'upper',
	jacket: 'upper',
	bottom: 'lower',
	bottoms: 'lower',
	pants: 'lower',
	'full-body': 'full_body',
	full_body: 'full_body',
	dress: 'full_body',
	footwear: 'footwear',
	shoes: 'footwear',
	accessory: 'accessory',
};

const DEFAULT_DINO_VERSION = '6b3d9f86b7c525271f4bdc29b50baa1cdb987faa0f67161499a22ea603dbd3a7';
const REPLICATE_PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions';
const WAIT_BUDGET_MS = 480_000;
const POLL_MS = 2_000;

const OPENCLIP_MODELS = {
	fashionsiglip: 'hf-hub:Marqo/marqo-fashionSigLIP',
	'moda-distilled': 'hf-hub:HopitAI/moda-fashion-distilled',
};

/** Vision-only MODA: not a plain open_clip hub (no open_clip_config.json). */
const MODA_VISION_REPO = 'HopitAI/moda-fashion-vision-fp16';
const MODA_VISION_BASE = 'hf-hub:Marqo/marqo-fashionSigLIP';

const ALL_ENCODERS = [
	'dinov3-cls',
	'dinov3-patch',
	'dinov3-patch-flip',
	'fashionsiglip',
	'moda',
	'moda-distilled',
];

function parseArgs(argv) {
	const flags = new Set();
	const opts = { encoders: ['dinov3-cls'] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--smoke') opts.smoke = argv[++i];
		else if (arg === '--encoders') {
			opts.encoders = String(argv[++i] || '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (arg === '--penalty') opts.penalty = Number(argv[++i]);
		else if (arg === '--dark-penalty') opts.darkPenalty = Number(argv[++i]);
		else if (arg === '--ask-floor') opts.askFloor = Number(argv[++i]);
		else if (arg === '--color-weight') opts.colorWeight = Number(argv[++i]);
		else if (arg === '--chroma-hue-min-s') opts.chromaHueMinS = Number(argv[++i]);
		else if (arg === '--dark-ignore-hue') flags.add('darkIgnoreHue');
		else if (arg === '--sweep') flags.add('sweep');
		else if (arg === '--json') flags.add('json');
		else if (arg === '--help' || arg === '-h') flags.add('help');
		else if (arg === '--all') opts.encoders = [...ALL_ENCODERS];
	}
	return { flags, opts };
}

function parseDevVars(text) {
	const out = {};
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 0) continue;
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[trimmed.slice(0, eq).trim()] = value;
	}
	return out;
}

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

function resolveSlot(category) {
	const key = category?.trim().toLowerCase();
	return key ? SLOT_BY_CATEGORY[key] : undefined;
}

function normalizeSubcategory(value) {
	const key = value?.trim().toLowerCase();
	return key || null;
}

function subcategoryRelation(probeSub, neighborSub, slot) {
	if (!slot || !SUBCATEGORY_STRICT_SLOTS.has(slot)) return 'open';
	const probe = normalizeSubcategory(probeSub);
	const neighbor = normalizeSubcategory(neighborSub);
	if (!probe || !neighbor) return 'open';
	if (probe === neighbor) return 'exact';
	if (slot === 'footwear' && CLOSED_SHOE_SUBCATEGORIES.has(probe) && CLOSED_SHOE_SUBCATEGORIES.has(neighbor)) {
		return 'family';
	}
	return 'reject';
}

function isDarkNeutral(hsl) {
	return hsl.l < 0.38 && hsl.s < 0.28;
}
function isDarkNeutralPair(a, b) {
	if (isDarkNeutral(a) && isDarkNeutral(b)) return true;
	const meanL = (a.l + b.l) / 2;
	const maxL = Math.max(a.l, b.l);
	const maxS = Math.max(a.s, b.s);
	return meanL < 0.34 && maxL < 0.42 && maxS < 0.3;
}
function isNearBlack(hsl) {
	return hsl.l < 0.22 && hsl.s < 0.18;
}
/**
 * @param {{ chromaHueMinS?: number, darkIgnoreHue?: boolean }} [opts]
 */
function cropColorDistance(a, b, opts = {}) {
	const chromaMin = Number.isFinite(opts.chromaHueMinS) ? opts.chromaHueMinS : CHROMA_HUE_MIN_S;
	const dL = a.l - b.l;
	const dS = a.s - b.s;
	const ignoreHue = Boolean(opts.darkIgnoreHue) && isDarkNeutralPair(a, b);
	const hueWeight = ignoreHue ? 0 : Math.min(a.s, b.s) > chromaMin ? 1 : 0;
	let dH = Math.abs(a.h - b.h) % 360;
	if (dH > 180) dH = 360 - dH;
	dH = (dH / 180) * hueWeight;
	const distance = Math.hypot(dL, dS, dH);
	if (isNearBlack(a) !== isNearBlack(b)) {
		const other = isNearBlack(a) ? b : a;
		const charcoalPeer = other.l < 0.32 && other.s < 0.2;
		if (!charcoalPeer) return Math.max(distance, 0.45);
	}
	return distance;
}
function identityColorFullPenalty(a, b, basePenalty, darkPenalty) {
	const dark =
		Number.isFinite(darkPenalty) && darkPenalty > 0
			? darkPenalty
			: COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL;
	if (a && b && isDarkNeutralPair(a, b)) {
		return Math.max(basePenalty, dark);
	}
	return basePenalty;
}
/**
 * @param {number} colorWeight - weight on color agree in [0,1]; floor is (1 - colorWeight).
 */
function identityScore(cosine, colorDistance, fullPenalty, colorWeight = 0.75) {
	if (colorDistance == null || !Number.isFinite(colorDistance)) return cosine;
	const penalty = Number.isFinite(fullPenalty) && fullPenalty > 0 ? fullPenalty : COLOR_DISTANCE_FULL_PENALTY;
	const w = Number.isFinite(colorWeight) ? Math.min(1, Math.max(0, colorWeight)) : 0.75;
	const agree = Math.max(0, 1 - colorDistance / penalty);
	return cosine * (1 - w + w * agree);
}
function cosineSimilarity(a, b) {
	if (!a?.length || !b?.length || a.length !== b.length) return null;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	if (!(denom > 0)) return null;
	return dot / denom;
}
function l2Normalize(values) {
	const norm = Math.sqrt(values.reduce((sum, n) => sum + n * n, 0));
	if (!(norm > 0)) throw new Error('zero-norm embedding');
	return values.map((n) => n / norm);
}
function meanPool(tokens) {
	if (!tokens.length) throw new Error('empty token sequence');
	const dim = tokens[0].length;
	const out = new Array(dim).fill(0);
	for (const tok of tokens) {
		for (let i = 0; i < dim; i++) out[i] += tok[i];
	}
	return out.map((n) => n / tokens.length);
}
function isNumericVector(value) {
	return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Prefer patch tokens (drop CLS) when last_hidden_state is present; else CLS vector. */
function parseDinoPooling(json, mode) {
	let hidden = json;
	if (hidden && typeof hidden === 'object' && !Array.isArray(hidden)) {
		if ('last_hidden_state' in hidden) hidden = hidden.last_hidden_state;
		else if ('embeddings' in hidden) hidden = hidden.embeddings;
		else if ('embedding' in hidden) hidden = hidden.embedding;
	}
	if (typeof hidden === 'string' && hidden.trim().startsWith('[')) {
		hidden = JSON.parse(hidden);
	}
	if (isNumericVector(hidden)) {
		if (mode !== 'cls') {
			throw new Error(
				'DINOv3 Replicate Cog returns CLS-only (1024). Patch-pool / flip TTA need a Cog that emits last_hidden_state [seq,1024]. Skip dinov3-patch* until that ships, or use fashionsiglip / MODA.'
			);
		}
		return l2Normalize(hidden);
	}
	if (!Array.isArray(hidden) || !hidden.length) {
		throw new Error('DINOv3 response missing vector');
	}
	// [seq, hidden] or [batch, seq, hidden]
	let seq = hidden;
	if (Array.isArray(hidden[0]) && Array.isArray(hidden[0][0])) {
		seq = hidden[0];
	}
	if (!Array.isArray(seq[0]) || !isNumericVector(seq[0])) {
		throw new Error('DINOv3 sequence parse failed');
	}
	if (mode === 'cls') {
		return l2Normalize(seq[0]);
	}
	const patches = seq.length > 1 ? seq.slice(1) : seq;
	return l2Normalize(meanPool(patches));
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

async function latestProbeSmoke() {
	const names = (await readdir(SMOKE_DIR)).filter((f) => f.startsWith('smoke_') && f.endsWith('.json'));
	let best = null;
	let bestMtime = 0;
	for (const name of names) {
		const path = join(SMOKE_DIR, name);
		const j = await readJson(path);
		if (!(j.probe_count > 0)) continue;
		const st = await stat(path);
		if (st.mtimeMs > bestMtime) {
			bestMtime = st.mtimeMs;
			best = path;
		}
	}
	return best;
}

function garmentIdForItem(labels, file, itemIndex) {
	return labels?.photos?.[file]?.items?.[String(itemIndex)]?.garment_id?.trim() || null;
}

async function replicatePredict(token, version, imageUri, signal) {
	const deadline = Date.now() + WAIT_BUDGET_MS;
	let prediction = await fetch(REPLICATE_PREDICTIONS_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Prefer: 'wait',
		},
		body: JSON.stringify({ version, input: { image: imageUri } }),
		signal,
	}).then(async (res) => {
		const json = await res.json();
		if (!res.ok) throw new Error(`Replicate ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
		return json;
	});

	while (Date.now() < deadline) {
		if (prediction.status === 'succeeded' || (prediction.output != null && prediction.status !== 'starting' && prediction.status !== 'processing')) {
			let output = prediction.output;
			if (typeof output === 'string' && /^https?:\/\//.test(output.trim())) {
				const fileRes = await fetch(output.trim(), { signal });
				output = await fileRes.json();
			}
			return output;
		}
		if (prediction.status === 'failed' || prediction.status === 'canceled') {
			throw new Error(`Replicate ${prediction.status}: ${prediction.error || ''}`);
		}
		const pollUrl = prediction.urls?.get || (prediction.id ? `${REPLICATE_PREDICTIONS_URL}/${prediction.id}` : '');
		if (!pollUrl) break;
		await sleep(POLL_MS);
		prediction = await fetch(pollUrl, {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
			signal,
		}).then((res) => res.json());
	}
	throw new Error(`Replicate timeout (${prediction.status})`);
}

async function cachePath(encoder, cropKey) {
	const dir = join(CACHE_DIR, encoder);
	await mkdir(dir, { recursive: true });
	return join(dir, `${cropKey}.json`);
}

async function loadCachedVector(encoder, cropKey) {
	const path = await cachePath(encoder, cropKey);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		if (Array.isArray(parsed.vector) && parsed.vector.length) return parsed;
	} catch {
		/* miss */
	}
	return null;
}

async function saveCachedVector(encoder, cropKey, payload) {
	const path = await cachePath(encoder, cropKey);
	await writeFile(path, JSON.stringify(payload));
}

async function embedDinoFromCrop({ token, version, cropAbs, mode, flip }) {
	let bytes = await readFile(cropAbs);
	if (flip) {
		bytes = await sharp(bytes).flop().jpeg().toBuffer();
	}
	const uri = `data:image/jpeg;base64,${bytes.toString('base64')}`;
	const output = await replicatePredict(token, version, uri);
	return parseDinoPooling(output, mode);
}

const BAKEOFF_PYTHON = existsSync(join(ROOT, 'tmp/bakeoff-venv/bin/python3'))
	? join(ROOT, 'tmp/bakeoff-venv/bin/python3')
	: 'python3';

function attachLineWorker(child, label) {
	let buf = '';
	const waiters = [];
	child.stderr.on('data', (d) => {
		const t = String(d);
		if (!t.includes('Downloading') && !t.includes('Fetching')) {
			process.stderr.write(t);
		}
	});
	child.stdout.on('data', (d) => {
		buf += d;
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			if (line === 'loading' || line === 'ready') {
				waiters.shift()?.(line);
				continue;
			}
			waiters.shift()?.(line);
		}
	});
	let onError = null;
	child.on('error', (err) => onError?.(err));
	const nextLine = () =>
		new Promise((resolvePromise, reject) => {
			onError = reject;
			waiters.push((line) => {
				onError = null;
				if (typeof line === 'string') resolvePromise(line);
				else reject(line);
			});
		});
	return {
		label,
		async start() {
			const first = await nextLine();
			if (first === 'ready') return;
			if (first !== 'loading') throw new Error(`${label} worker: ${first}`);
			const second = await nextLine();
			if (second !== 'ready') throw new Error(`${label} worker: ${second}`);
		},
		async embed(cropAbs) {
			child.stdin.write(`${cropAbs}\n`);
			const line = await nextLine();
			const parsed = JSON.parse(line);
			if (parsed?.error) throw new Error(parsed.error);
			return parsed;
		},
		async close() {
			try {
				child.stdin.write('QUIT\n');
			} catch {
				/* ignore */
			}
			child.kill();
		},
	};
}

/** One long-lived worker so HF weights load once for the whole smoke. */
function createOpenClipWorker(hfHubId, label) {
	const script = `
import json, sys
from PIL import Image
import open_clip
import torch
hub = ${JSON.stringify(hfHubId)}
print('loading', flush=True)
model, _, preprocess = open_clip.create_model_and_transforms(hub)
model.eval()
print('ready', flush=True)
for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    if path == 'QUIT':
        break
    try:
        im = preprocess(Image.open(path).convert('RGB')).unsqueeze(0)
        with torch.no_grad():
            z = model.encode_image(im)
            z = z / z.norm(dim=-1, keepdim=True)
        print(json.dumps(z[0].tolist()), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
`;
	const child = spawn(BAKEOFF_PYTHON, ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
	return attachLineWorker(child, label);
}

/**
 * MODA vision-fp16: FashionSigLIP architecture + overlay vision_encoder.safetensors
 * (official HopitAI load path; hub lacks open_clip_config.json).
 */
function createModaVisionWorker(label) {
	const script = `
import json, sys
from PIL import Image
import open_clip
import torch
import torch.nn.functional as F
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file
repo = ${JSON.stringify(MODA_VISION_REPO)}
base = ${JSON.stringify(MODA_VISION_BASE)}
print('loading', flush=True)
model, _, preprocess = open_clip.create_model_and_transforms(base)
weights = hf_hub_download(repo_id=repo, filename='vision_encoder.safetensors')
vision_sd = {k: v.float() for k, v in load_file(weights).items()}
full_sd = model.state_dict()
for k, v in vision_sd.items():
    full_sd[k] = v
model.load_state_dict(full_sd, strict=True)
encoder = model.visual
encoder.eval()
print('ready', flush=True)
for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    if path == 'QUIT':
        break
    try:
        im = preprocess(Image.open(path).convert('RGB')).unsqueeze(0)
        with torch.no_grad():
            z = encoder(im)
            z = F.normalize(z, p=2, dim=-1)
        print(json.dumps(z[0].tolist()), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
`;
	const child = spawn(BAKEOFF_PYTHON, ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
	return attachLineWorker(child, label);
}

async function resolveVectorsForSmoke({ smoke, encoders, env }) {
	/** @type {Map<string, Map<string, number[]>>} encoder -> itemKey -> vector */
	const byEncoder = new Map();
	const items = [];

	for (const result of smoke.results || []) {
		if (!result.ok) continue;
		for (let index = 0; index < (result.items || []).length; index++) {
			const item = result.items[index];
			const probe = item.identity_probe;
			if (!probe?.vector?.length) continue;
			const cropRel = probe.crop_path;
			const cropAbs = cropRel ? join(ROOT, cropRel) : null;
			const cropBytes = cropAbs && existsSync(cropAbs) ? await readFile(cropAbs) : null;
			const cropKey = cropBytes ? sha256Hex(cropBytes).slice(0, 24) : `noprobe-${result.file}-${index}`;
			items.push({
				file: result.file,
				index,
				item,
				probe,
				cropAbs,
				cropKey,
				key: `${result.file}|${index}`,
			});
		}
	}

	/** @type {Map<string, ReturnType<typeof attachLineWorker>>} */
	const openClipWorkers = new Map();

	async function ensureOpenClipWorker(encoder) {
		if (openClipWorkers.has(encoder)) return openClipWorkers.get(encoder);
		if (encoder === 'moda') {
			process.stdout.write(
				`\n  [${encoder}] loading ${MODA_VISION_REPO} (SigLIP base + vision_encoder.safetensors)…\n`
			);
			const worker = createModaVisionWorker(encoder);
			await worker.start();
			openClipWorkers.set(encoder, worker);
			return worker;
		}
		const hub = OPENCLIP_MODELS[encoder];
		if (!hub) throw new Error(`No OpenCLIP hub for ${encoder}`);
		process.stdout.write(`\n  [${encoder}] loading ${hub} (first run downloads weights)…\n`);
		const worker = createOpenClipWorker(hub, encoder);
		await worker.start();
		openClipWorkers.set(encoder, worker);
		return worker;
	}

	try {
		for (const encoder of encoders) {
			const map = new Map();
			byEncoder.set(encoder, map);
			let i = 0;
			let cacheHits = 0;
			for (const row of items) {
				i += 1;
				process.stdout.write(`\r  [${encoder}] ${i}/${items.length} ${row.file}[${row.index}]   `);
				if (encoder === 'dinov3-cls') {
					map.set(row.key, row.probe.vector);
					continue;
				}

				const cached = await loadCachedVector(encoder, row.cropKey);
				if (cached?.vector) {
					cacheHits += 1;
					map.set(row.key, cached.vector);
					continue;
				}

				if (!row.cropAbs || !existsSync(row.cropAbs)) {
					throw new Error(`${encoder} needs crop_path for ${row.key}`);
				}

				let vector;
				if (encoder === 'dinov3-patch' || encoder === 'dinov3-patch-flip') {
					const token = env.REPLICATE_API_TOKEN?.trim();
					if (!token) throw new Error('REPLICATE_API_TOKEN required for dinov3-patch*');
					const version = env.CLOSET_EMBED_MODEL?.includes(':')
						? env.CLOSET_EMBED_MODEL.split(':').pop()
						: DEFAULT_DINO_VERSION;
					if (encoder === 'dinov3-patch') {
						vector = await embedDinoFromCrop({
							token,
							version,
							cropAbs: row.cropAbs,
							mode: 'patch',
							flip: false,
						});
					} else {
						const a = await embedDinoFromCrop({
							token,
							version,
							cropAbs: row.cropAbs,
							mode: 'patch',
							flip: false,
						});
						const b = await embedDinoFromCrop({
							token,
							version,
							cropAbs: row.cropAbs,
							mode: 'patch',
							flip: true,
						});
						vector = l2Normalize(a.map((n, idx) => (n + b[idx]) / 2));
					}
				} else if (encoder === 'moda' || OPENCLIP_MODELS[encoder]) {
					const worker = await ensureOpenClipWorker(encoder);
					vector = l2Normalize(await worker.embed(row.cropAbs));
				} else {
					throw new Error(`Unknown encoder ${encoder}`);
				}

				await saveCachedVector(encoder, row.cropKey, {
					encoder,
					crop_key: row.cropKey,
					dimensions: vector.length,
					vector,
					source: row.file,
					index: row.index,
				});
				map.set(row.key, vector);
			}
			process.stdout.write(
				encoder === 'dinov3-cls' ? '\n' : `\n  [${encoder}] cache ${cacheHits}/${items.length}\n`
			);
		}
	} finally {
		for (const worker of openClipWorkers.values()) {
			await worker.close();
		}
	}

	return { items, byEncoder };
}

function replayWithVectors({
	smoke,
	labels,
	vectors,
	penalty,
	darkPenalty,
	askFloor,
	colorWeight = 0.75,
	chromaHueMinS = CHROMA_HUE_MIN_S,
	darkIgnoreHue = false,
}) {
	const closet = new Map();
	const rows = [];
	let rewearTotal = 0;
	let rewearHit = 0;
	let falseAsk = 0;
	const sameCos = [];
	const diffCos = [];
	const colorOpts = { chromaHueMinS, darkIgnoreHue };

	for (const result of smoke.results || []) {
		if (!result.ok) continue;
		const file = result.file;
		for (let index = 0; index < (result.items || []).length; index++) {
			const item = result.items[index];
			const key = `${file}|${index}`;
			const vector = vectors.get(key);
			const garmentId = garmentIdForItem(labels, file, index);
			const color = item.identity_probe?.crop_color ?? null;
			if (!vector || !garmentId) continue;

			const slot = resolveSlot(item.category);
			const isRewear = Boolean(closet.get(garmentId)?.length);

			let best = null;
			for (const [candId, protos] of closet.entries()) {
				for (const proto of protos) {
					if (slot && proto.slot && slot !== proto.slot) continue;
					const relation = subcategoryRelation(item.subcategory, proto.subcategory, slot);
					if (relation === 'reject') continue;
					const cos = cosineSimilarity(vector, proto.vector);
					if (cos == null) continue;
					if (candId === garmentId) sameCos.push(cos);
					else diffCos.push(cos);
					const colorD =
						color && proto.color ? cropColorDistance(color, proto.color, colorOpts) : null;
					const fullPen = identityColorFullPenalty(color, proto.color, penalty, darkPenalty);
					let score = identityScore(cos, colorD, fullPen, colorWeight);
					if (relation === 'family') score *= SUBCATEGORY_FAMILY_PENALTY;
					if (!best || score > best.score) {
						best = { garment_id: candId, score, cosine: cos, color_distance: colorD };
					}
				}
			}

			let action = 'create';
			if (best && best.score >= askFloor) action = 'ask';

			if (isRewear) {
				rewearTotal += 1;
				if (action === 'ask' && best?.garment_id === garmentId) rewearHit += 1;
				else if (action === 'ask') falseAsk += 1;
			} else if (action === 'ask') {
				falseAsk += 1;
			}

			rows.push({
				file,
				index,
				garment_id: garmentId,
				is_rewear: isRewear,
				action,
				score: best?.score ?? null,
				cosine: best?.cosine ?? null,
				color_distance: best?.color_distance ?? null,
				candidate_garment_id: best?.garment_id ?? null,
				correct_neighbor: best ? best.garment_id === garmentId : null,
			});

			const list = closet.get(garmentId) || [];
			list.push({
				vector,
				color,
				category: item.category,
				subcategory: item.subcategory,
				slot: slot || 'unknown',
			});
			closet.set(garmentId, list);
		}
	}

	const stats = (arr) => {
		if (!arr.length) return null;
		const sorted = [...arr].sort((a, b) => a - b);
		const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
		const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
		return {
			n: arr.length,
			mean,
			p10: pct(10),
			p50: pct(50),
			p90: pct(90),
			min: sorted[0],
			max: sorted[sorted.length - 1],
		};
	};

	const photoCount = (smoke.results || []).filter((r) => r.ok).length || 1;
	return {
		rewear_total: rewearTotal,
		rewear_hit: rewearHit,
		rewear_recall: rewearTotal ? rewearHit / rewearTotal : null,
		false_ask: falseAsk,
		false_ask_per_photo: falseAsk / photoCount,
		same_cosine: stats(sameCos),
		diff_cosine: stats(diffCos),
		rows,
	};
}

function fmtStats(s) {
	if (!s) return 'n=0';
	return `n=${s.n} mean=${s.mean.toFixed(3)} p50=${s.p50.toFixed(3)} p10=${s.p10.toFixed(3)} p90=${s.p90.toFixed(3)}`;
}

function printReplayReport(encoder, report) {
	const pct = report.rewear_recall == null ? '—' : `${(100 * report.rewear_recall).toFixed(1)}%`;
	console.log(`\n=== ${encoder} ===`);
	console.log(`  rewear recall  ${report.rewear_hit}/${report.rewear_total}  ${pct}`);
	console.log(`  false asks     ${report.false_ask}  (~${report.false_ask_per_photo.toFixed(2)}/photo)`);
	console.log(`  same-garment cos   ${fmtStats(report.same_cosine)}`);
	console.log(`  different-garment  ${fmtStats(report.diff_cosine)}`);
	const misses = report.rows.filter((r) => r.is_rewear && !(r.action === 'ask' && r.correct_neighbor));
	if (misses.length) {
		console.log('  missed rewears:');
		for (const r of misses) {
			console.log(
				`    ${r.file}[${r.index}] ${r.garment_id} → ${r.action}` +
					(r.score != null
						? ` score=${r.score.toFixed(3)} cos=${r.cosine?.toFixed(3)} cd=${r.color_distance?.toFixed(3)} cand=${r.candidate_garment_id}`
						: '')
			);
		}
	}
}

function sweepConfigs() {
	const penalties = [0.3, 0.45, 0.6, 0.8, 1.0];
	const darkPenalties = [0.3, 0.6, 0.9, 1.2];
	const askFloors = [0.4, 0.45, 0.5];
	const colorWeights = [0.75, 0.6, 0.5];
	const chromaHueMinS = [0.12, 0.2, 0.28, 0.4];
	const darkIgnoreHue = [false, true];
	const out = [];
	for (const penalty of penalties) {
		for (const darkPenalty of darkPenalties) {
			for (const askFloor of askFloors) {
				for (const colorWeight of colorWeights) {
					for (const chroma of chromaHueMinS) {
						for (const ignoreHue of darkIgnoreHue) {
							out.push({
								penalty,
								darkPenalty,
								askFloor,
								colorWeight,
								chromaHueMinS: chroma,
								darkIgnoreHue: ignoreHue,
							});
						}
					}
				}
			}
		}
	}
	return out;
}

function rankSweepRows(rows) {
	return [...rows].sort((a, b) => {
		if (b.rewear_hit !== a.rewear_hit) return b.rewear_hit - a.rewear_hit;
		if (a.false_ask !== b.false_ask) return a.false_ask - b.false_ask;
		if (a.askFloor !== b.askFloor) return b.askFloor - a.askFloor;
		return a.penalty - b.penalty;
	});
}

async function main() {
	const { flags, opts } = parseArgs(process.argv.slice(2));
	if (flags.has('help')) {
		console.log(`Usage: npm run identity:bakeoff -- [options]
  --smoke <path>
  --encoders dinov3-cls,fashionsiglip,moda,moda-distilled
  --all
  --ask-floor <n>  --penalty <n>  --dark-penalty <n>
  --color-weight <n>  --chroma-hue-min-s <n>  --dark-ignore-hue
  --sweep            grid over color/ask params (cached vectors)
  --json`);
		return;
	}

	const smokePath = opts.smoke ? resolve(opts.smoke) : await latestProbeSmoke();
	if (!smokePath || !existsSync(smokePath)) {
		throw new Error('No smoke with probes. Run extract:smoke first.');
	}
	if (!existsSync(LABELS_PATH)) throw new Error(`Missing ${LABELS_PATH}`);

	const env = parseDevVars(await readFile(join(ROOT, '.dev.vars'), 'utf8').catch(() => ''));
	const smoke = await readJson(smokePath);
	const labels = await readJson(LABELS_PATH);
	const askFloor = Number.isFinite(opts.askFloor) ? opts.askFloor : IDENTITY_MATCH_MIN;
	const penalty = Number.isFinite(opts.penalty) ? opts.penalty : COLOR_DISTANCE_FULL_PENALTY;
	const darkPenalty = Number.isFinite(opts.darkPenalty)
		? opts.darkPenalty
		: COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL;
	const colorWeight = Number.isFinite(opts.colorWeight) ? opts.colorWeight : 0.75;
	const chromaHueMinS = Number.isFinite(opts.chromaHueMinS) ? opts.chromaHueMinS : CHROMA_HUE_MIN_S;
	const darkIgnoreHue = flags.has('darkIgnoreHue');

	console.log(`Smoke:     ${basename(smokePath)}`);
	console.log(`Encoders:  ${opts.encoders.join(', ')}`);

	const { byEncoder } = await resolveVectorsForSmoke({ smoke, encoders: opts.encoders, env });

	if (flags.has('sweep')) {
		const configs = sweepConfigs();
		console.log(`Sweep:     ${configs.length} configs × ${opts.encoders.length} encoders`);
		const byEnc = {};
		for (const encoder of opts.encoders) {
			const vectors = byEncoder.get(encoder);
			const rows = [];
			for (const cfg of configs) {
				const report = replayWithVectors({
					smoke,
					labels,
					vectors,
					...cfg,
				});
				rows.push({
					...cfg,
					rewear_hit: report.rewear_hit,
					rewear_total: report.rewear_total,
					rewear_recall: report.rewear_recall,
					false_ask: report.false_ask,
					false_ask_per_photo: report.false_ask_per_photo,
				});
			}
			const ranked = rankSweepRows(rows);
			byEnc[encoder] = ranked;
			const baseline = rows.find(
				(r) =>
					r.penalty === 0.3 &&
					r.darkPenalty === 0.3 &&
					r.askFloor === 0.5 &&
					r.colorWeight === 0.75 &&
					r.chromaHueMinS === 0.12 &&
					r.darkIgnoreHue === false
			);
			console.log(`\n=== ${encoder} sweep (top 12 by recall, then fewer false asks) ===`);
			if (baseline) {
				console.log(
					`  baseline  recall ${baseline.rewear_hit}/${baseline.rewear_total}  false=${baseline.false_ask}  (~${baseline.false_ask_per_photo.toFixed(2)}/photo)`
				);
			}
			console.log(
				'  hit  false  ask  pen  dark  cw   hueS  ignH'
			);
			for (const r of ranked.slice(0, 12)) {
				console.log(
					`  ${String(r.rewear_hit).padStart(2)}/${r.rewear_total}  ${String(r.false_ask).padStart(2)}     ` +
						`${r.askFloor.toFixed(2)} ${r.penalty.toFixed(2)} ${r.darkPenalty.toFixed(2)} ` +
						`${r.colorWeight.toFixed(2)} ${r.chromaHueMinS.toFixed(2)}  ${r.darkIgnoreHue ? 'Y' : 'n'}`
				);
			}
			const pareto = ranked.filter((r) => r.false_ask <= 1 && r.rewear_hit > (baseline?.rewear_hit ?? 0));
			if (pareto.length) {
				console.log(`  best with ≤1 false ask & >baseline recall:`);
				const best = pareto[0];
				console.log(
					`    ${best.rewear_hit}/${best.rewear_total} false=${best.false_ask} ask=${best.askFloor} pen=${best.penalty} dark=${best.darkPenalty} cw=${best.colorWeight} hueS=${best.chromaHueMinS} ignH=${best.darkIgnoreHue}`
				);
			} else {
				console.log('  (no config beats baseline recall with ≤1 false ask)');
			}
		}

		const outPath = join(SMOKE_DIR, `bakeoff_sweep_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
		await writeFile(
			outPath,
			JSON.stringify({ smoke: basename(smokePath), encoders: opts.encoders, sweep: byEnc }, null, 2)
		);
		console.log(`\nWrote ${outPath}`);
		if (flags.has('json')) console.log(JSON.stringify(byEnc, null, 2));
		return;
	}

	console.log(
		`ask≥${askFloor}  penalty=${penalty}  dark=${darkPenalty}  colorWeight=${colorWeight}  hueS=${chromaHueMinS}  ignH=${darkIgnoreHue}`
	);

	const reports = {};
	for (const encoder of opts.encoders) {
		const report = replayWithVectors({
			smoke,
			labels,
			vectors: byEncoder.get(encoder),
			penalty,
			darkPenalty,
			askFloor,
			colorWeight,
			chromaHueMinS,
			darkIgnoreHue,
		});
		reports[encoder] = report;
		printReplayReport(encoder, report);
	}

	const outPath = join(SMOKE_DIR, `bakeoff_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
	await writeFile(
		outPath,
		JSON.stringify(
			{
				smoke: basename(smokePath),
				askFloor,
				penalty,
				darkPenalty,
				colorWeight,
				chromaHueMinS,
				darkIgnoreHue,
				encoders: opts.encoders,
				reports,
			},
			null,
			2
		)
	);
	console.log(`\nWrote ${outPath}`);
	if (flags.has('json')) console.log(JSON.stringify(reports, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
