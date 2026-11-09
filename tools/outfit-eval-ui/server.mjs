#!/usr/bin/env node
/**
 * Local labeling UI for outfit extract / identity smoke runs.
 *
 *   npm run eval:ui
 *   open http://127.0.0.1:8788
 *
 * Env overrides:
 *   OUTFIT_EVAL_SET   photo folder (default: ../outfits-set-v1)
 *   OUTFIT_EVAL_SMOKE smoke JSON folder (default: tmp/extract_smoke)
 *   OUTFIT_EVAL_PORT  port (default: 8788)
 *
 * Ground-truth garments: <SET>/manifest.json (see docs/identity_manifest.md).
 * Seed copy: tools/outfit-eval-ui/seed/outfits-set-v1.manifest.json
 */
import { createServer } from 'node:http';
import { readdir, readFile, writeFile, mkdir, stat, copyFile, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { basename, extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const SEED_MANIFEST = join(fileURLToPath(new URL('.', import.meta.url)), 'seed/outfits-set-v1.manifest.json');
const SET_DIR = resolve(process.env.OUTFIT_EVAL_SET || join(ROOT, '../outfits-set-v1'));
const SMOKE_DIR = resolve(process.env.OUTFIT_EVAL_SMOKE || join(ROOT, 'tmp/extract_smoke'));
const LABELS_PATH = join(SMOKE_DIR, 'labels.json');
const MANIFEST_PATH = join(SET_DIR, 'manifest.json');
const IDENTITY_RUNS_DIR = resolve(process.env.OUTFIT_EVAL_IDENTITY_RUNS || join(ROOT, '.cursor/identity_runs'));
const PORT = Number(process.env.OUTFIT_EVAL_PORT || 8788);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG', '.WEBP']);

function contentType(path) {
	switch (extname(path).toLowerCase()) {
		case '.html':
			return 'text/html; charset=utf-8';
		case '.js':
			return 'text/javascript; charset=utf-8';
		case '.css':
			return 'text/css; charset=utf-8';
		case '.json':
			return 'application/json; charset=utf-8';
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		case '.png':
			return 'image/png';
		case '.webp':
			return 'image/webp';
		default:
			return 'application/octet-stream';
	}
}

function sendJson(res, status, body) {
	const data = JSON.stringify(body, null, 2);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});
	res.end(data);
}

function sendText(res, status, text) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end(text);
}

function safeJoin(root, rel) {
	const full = resolve(root, rel);
	const normalizedRoot = resolve(root);
	if (!full.startsWith(normalizedRoot + '/') && full !== normalizedRoot) {
		return null;
	}
	return full;
}

async function emptyLabels() {
	return {
		version: 1,
		updated_at: null,
		photos: {},
	};
}

function emptyManifest() {
	return {
		version: 1,
		set: basename(SET_DIR),
		updated_at: null,
		garments: [],
		photos: {},
	};
}

function normalizeManifest(raw) {
	const base = emptyManifest();
	if (!raw || typeof raw !== 'object') return base;
	return {
		version: Number(raw.version) || 1,
		set: typeof raw.set === 'string' ? raw.set : base.set,
		updated_at: raw.updated_at ?? null,
		garments: Array.isArray(raw.garments) ? raw.garments : [],
		photos: raw.photos && typeof raw.photos === 'object' ? raw.photos : {},
	};
}

function countPhotoKeys(photos) {
	return photos && typeof photos === 'object' ? Object.keys(photos).length : 0;
}

function countLabeledItems(photos) {
	let n = 0;
	if (!photos || typeof photos !== 'object') return 0;
	for (const photo of Object.values(photos)) {
		const items = photo?.items;
		if (!items || typeof items !== 'object') continue;
		for (const item of Object.values(items)) {
			if (item && (item.garment_id || item.human_verdict || item.extract_verdict || item.notes)) n += 1;
		}
	}
	return n;
}

/** Write via temp + rename so a crash cannot leave a 0-byte labels/manifest file. */
async function writeJsonAtomic(path, value) {
	const dir = resolve(path, '..');
	await mkdir(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
	const payload = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	if (typeof payload !== 'string' || !payload.trim() || payload === 'null') {
		throw new Error(`Refusing to write empty JSON to ${path}`);
	}
	await writeFile(tmp, payload, 'utf8');
	// Backup previous good file (best-effort) before replacing.
	if (existsSync(path)) {
		try {
			await copyFile(path, `${path}.bak`);
		} catch (err) {
			console.warn(`backup failed for ${path}:`, err?.message || err);
		}
	}
	await rename(tmp, path);
}

async function loadLabels() {
	try {
		const raw = await readFile(LABELS_PATH, 'utf8');
		if (!raw.trim()) {
			console.warn(`labels.json is empty at ${LABELS_PATH}; starting fresh`);
			return emptyLabels();
		}
		return JSON.parse(raw);
	} catch (err) {
		console.warn(`Failed to load labels from ${LABELS_PATH}:`, err?.message || err);
		return emptyLabels();
	}
}

/** Prefer set-local manifest; seed from repo copy once if missing. */
async function loadManifest() {
	try {
		const raw = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
		return normalizeManifest(raw);
	} catch {
		if (existsSync(SEED_MANIFEST) && existsSync(SET_DIR)) {
			try {
				await copyFile(SEED_MANIFEST, MANIFEST_PATH);
				const raw = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
				return normalizeManifest(raw);
			} catch {
				/* fall through */
			}
		}
		return emptyManifest();
	}
}

async function listSmokeRuns() {
	if (!existsSync(SMOKE_DIR)) return [];
	const names = await readdir(SMOKE_DIR);
	const runs = [];
	for (const name of names) {
		if (!name.startsWith('smoke_') || !name.endsWith('.json')) continue;
		const path = join(SMOKE_DIR, name);
		const st = await stat(path);
		let meta = {};
		try {
			const parsed = JSON.parse(await readFile(path, 'utf8'));
			meta = {
				ran_at: parsed.ran_at ?? null,
				model: parsed.model ?? null,
				source: parsed.source ?? 'claude_direct',
				user_id: parsed.user_id ?? null,
				photo_count: Array.isArray(parsed.results) ? parsed.results.length : 0,
				ok_count: Array.isArray(parsed.results) ? parsed.results.filter((r) => r.ok).length : 0,
			};
		} catch {
			/* ignore */
		}
		runs.push({ id: name, mtime: st.mtime.toISOString(), ...meta });
	}
	// Prefer API extract cycles, then newest mtime.
	runs.sort((a, b) => {
		const aApi = a.source === 'api_extract' ? 1 : 0;
		const bApi = b.source === 'api_extract' ? 1 : 0;
		if (aApi !== bApi) return bApi - aApi;
		return a.mtime < b.mtime ? 1 : -1;
	});
	return runs;
}

async function loadSmoke(id) {
	const path = safeJoin(SMOKE_DIR, basename(id));
	if (!path || !path.endsWith('.json')) return null;
	return JSON.parse(await readFile(path, 'utf8'));
}

async function listIdentityRuns() {
	if (!existsSync(IDENTITY_RUNS_DIR)) return [];
	const names = await readdir(IDENTITY_RUNS_DIR);
	const runs = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		try {
			const parsed = JSON.parse(await readFile(join(IDENTITY_RUNS_DIR, name), 'utf8'));
			runs.push({
				id: name,
				identity_run_id: parsed.identity_run_id,
				image_key: parsed.image_key,
				item_count: parsed.item_count,
				created: parsed.created,
				asked: parsed.asked,
				failed: parsed.failed,
				reviewed: parsed.reviewed === true,
				recorded_at: parsed.recorded_at,
			});
		} catch {
			/* ignore */
		}
	}
	runs.sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)));
	return runs;
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
		const { pathname } = url;

		if (req.method === 'GET' && pathname === '/api/config') {
			return sendJson(res, 200, {
				set_dir: SET_DIR,
				smoke_dir: SMOKE_DIR,
				labels_path: LABELS_PATH,
				manifest_path: MANIFEST_PATH,
				identity_runs_dir: IDENTITY_RUNS_DIR,
				set_exists: existsSync(SET_DIR),
				smoke_exists: existsSync(SMOKE_DIR),
				manifest_exists: existsSync(MANIFEST_PATH),
			});
		}

		if (req.method === 'GET' && pathname === '/api/manifest') {
			return sendJson(res, 200, await loadManifest());
		}

		if (req.method === 'PUT' && pathname === '/api/manifest') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const rawBody = Buffer.concat(chunks).toString('utf8');
			if (!rawBody.trim()) {
				return sendText(res, 400, 'Empty request body');
			}
			let body;
			try {
				body = JSON.parse(rawBody);
			} catch {
				return sendText(res, 400, 'Invalid JSON body');
			}
			if (!existsSync(SET_DIR)) {
				return sendText(res, 400, `Fixture set missing: ${SET_DIR}`);
			}
			const next = normalizeManifest({
				...body,
				updated_at: new Date().toISOString(),
			});
			if (!Array.isArray(next.garments)) {
				return sendText(res, 400, 'manifest.garments must be an array');
			}
			const force = body.force === true || url.searchParams.get('force') === '1';
			let existingGarments = 0;
			try {
				if (existsSync(MANIFEST_PATH)) {
					const existing = normalizeManifest(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
					existingGarments = existing.garments.length;
				}
			} catch {
				/* ignore */
			}
			if (!force && existingGarments > 0 && next.garments.length === 0) {
				return sendText(
					res,
					409,
					`Refusing to overwrite ${existingGarments} garments with an empty list. Pass force=1 if intentional.`
				);
			}
			try {
				await writeJsonAtomic(MANIFEST_PATH, next);
			} catch (err) {
				console.error('manifest write failed', err);
				return sendText(res, 500, `Failed to write manifest: ${err?.message || err}`);
			}
			return sendJson(res, 200, next);
		}

		if (req.method === 'GET' && pathname === '/api/smoke') {
			return sendJson(res, 200, { runs: await listSmokeRuns() });
		}

		if (req.method === 'GET' && pathname.startsWith('/api/smoke/')) {
			const id = decodeURIComponent(pathname.slice('/api/smoke/'.length));
			const data = await loadSmoke(id);
			if (!data) return sendText(res, 404, 'Smoke run not found');
			return sendJson(res, 200, data);
		}

		if (req.method === 'GET' && pathname === '/api/identity-runs') {
			return sendJson(res, 200, { runs: await listIdentityRuns() });
		}

		if (req.method === 'GET' && pathname.startsWith('/api/identity-runs/')) {
			const id = decodeURIComponent(pathname.slice('/api/identity-runs/'.length));
			const path = safeJoin(IDENTITY_RUNS_DIR, basename(id));
			if (!path) return sendText(res, 404, 'Not found');
			const data = JSON.parse(await readFile(path, 'utf8'));
			return sendJson(res, 200, data);
		}

		if (req.method === 'GET' && pathname === '/api/labels') {
			return sendJson(res, 200, await loadLabels());
		}

		if (req.method === 'PUT' && pathname === '/api/labels') {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const rawBody = Buffer.concat(chunks).toString('utf8');
			if (!rawBody.trim()) {
				return sendText(res, 400, 'Empty request body');
			}
			let body;
			try {
				body = JSON.parse(rawBody);
			} catch {
				return sendText(res, 400, 'Invalid JSON body');
			}
			const photos = body.photos && typeof body.photos === 'object' && !Array.isArray(body.photos) ? body.photos : null;
			if (!photos) {
				return sendText(res, 400, 'labels.photos object required');
			}

			// Guard: never clobber a non-empty labels file with an empty payload.
			// This is what wiped ground truth when the UI state had photos: {}.
			let existing = null;
			try {
				if (existsSync(LABELS_PATH)) {
					const raw = await readFile(LABELS_PATH, 'utf8');
					if (raw.trim()) existing = JSON.parse(raw);
				}
			} catch (err) {
				console.warn('could not read existing labels before save:', err?.message || err);
			}
			const existingPhotos = existing?.photos && typeof existing.photos === 'object' ? existing.photos : {};
			const existingCount = countPhotoKeys(existingPhotos);
			const existingItems = countLabeledItems(existingPhotos);
			const nextCount = countPhotoKeys(photos);
			const nextItems = countLabeledItems(photos);
			const force = body.force === true || url.searchParams.get('force') === '1';
			if (!force && existingCount > 0 && nextCount === 0) {
				return sendText(
					res,
					409,
					`Refusing to overwrite ${existingCount} labeled photos with an empty photos object. Pass force=1 if intentional.`
				);
			}
			if (!force && existingItems > 0 && nextItems === 0 && nextCount < existingCount) {
				return sendText(
					res,
					409,
					`Refusing to drop all ${existingItems} item labels (had ${existingCount} photos, got ${nextCount}). Pass force=1 if intentional.`
				);
			}

			const next = {
				version: 1,
				updated_at: new Date().toISOString(),
				photos,
			};
			try {
				await writeJsonAtomic(LABELS_PATH, next);
			} catch (err) {
				console.error('labels write failed', err);
				return sendText(res, 500, `Failed to write labels: ${err?.message || err}`);
			}
			// Verify round-trip so the client never thinks a corrupt write succeeded.
			try {
				const verify = JSON.parse(await readFile(LABELS_PATH, 'utf8'));
				if (countPhotoKeys(verify.photos) !== nextCount) {
					throw new Error('post-write photo count mismatch');
				}
			} catch (err) {
				console.error('labels verify failed', err);
				return sendText(res, 500, `Labels write verify failed: ${err?.message || err}`);
			}
			return sendJson(res, 200, next);
		}

		if (req.method === 'GET' && pathname.startsWith('/photos/')) {
			const rel = decodeURIComponent(pathname.slice('/photos/'.length));
			const path = safeJoin(SET_DIR, rel);
			if (!path || !IMAGE_EXT.has(extname(path)) || !existsSync(path)) {
				return sendText(res, 404, 'Photo not found');
			}
			res.writeHead(200, {
				'Content-Type': contentType(path),
				'Cache-Control': 'private, max-age=3600',
			});
			createReadStream(path).pipe(res);
			return;
		}

		// static
		let rel = pathname === '/' ? '/index.html' : pathname;
		rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
		const filePath = safeJoin(PUBLIC, rel.replace(/^\//, ''));
		if (!filePath || !existsSync(filePath)) {
			return sendText(res, 404, 'Not found');
		}
		res.writeHead(200, { 'Content-Type': contentType(filePath) });
		createReadStream(filePath).pipe(res);
	} catch (err) {
		console.error(err);
		sendText(res, 500, String(err?.message || err));
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`Outfit eval UI → http://127.0.0.1:${PORT}`);
	console.log(`  photos:    ${SET_DIR}`);
	console.log(`  smoke:     ${SMOKE_DIR}`);
	console.log(`  labels:    ${LABELS_PATH}`);
	console.log(`  manifest:  ${MANIFEST_PATH}${existsSync(MANIFEST_PATH) ? '' : ' (will seed on first GET)'}`);
});
