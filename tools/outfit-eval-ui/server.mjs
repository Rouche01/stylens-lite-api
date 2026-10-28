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
 */
import { createServer } from 'node:http';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { basename, extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const SET_DIR = resolve(process.env.OUTFIT_EVAL_SET || join(ROOT, '../outfits-set-v1'));
const SMOKE_DIR = resolve(process.env.OUTFIT_EVAL_SMOKE || join(ROOT, 'tmp/extract_smoke'));
const LABELS_PATH = join(SMOKE_DIR, 'labels.json');
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

async function loadLabels() {
	try {
		const raw = await readFile(LABELS_PATH, 'utf8');
		return JSON.parse(raw);
	} catch {
		return emptyLabels();
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
				photo_count: Array.isArray(parsed.results) ? parsed.results.length : 0,
				ok_count: Array.isArray(parsed.results) ? parsed.results.filter((r) => r.ok).length : 0,
			};
		} catch {
			/* ignore */
		}
		runs.push({ id: name, mtime: st.mtime.toISOString(), ...meta });
	}
	runs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
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
				identity_runs_dir: IDENTITY_RUNS_DIR,
				set_exists: existsSync(SET_DIR),
				smoke_exists: existsSync(SMOKE_DIR),
			});
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
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			await mkdir(SMOKE_DIR, { recursive: true });
			const next = {
				version: 1,
				updated_at: new Date().toISOString(),
				photos: body.photos && typeof body.photos === 'object' ? body.photos : {},
			};
			await writeFile(LABELS_PATH, JSON.stringify(next, null, 2));
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
	console.log(`  photos:  ${SET_DIR}`);
	console.log(`  smoke:   ${SMOKE_DIR}`);
	console.log(`  labels:  ${LABELS_PATH}`);
});
