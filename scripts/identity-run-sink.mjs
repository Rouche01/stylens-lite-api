#!/usr/bin/env node
/**
 * Local identity-run artifact sink for the calibration review loop.
 *
 * Workers (even under wrangler dev) cannot write the host filesystem, and this
 * project's local R2 binding is remote — so we POST JSON here and write one file
 * per run under `.cursor/identity_runs/<identity_run_id>.json`.
 *
 * Usage (separate terminal while `npm run dev` is running):
 *   npm run identity:sink
 *
 * Default listen: http://127.0.0.1:8799/identity-runs
 * Override: IDENTITY_RUN_SINK_PORT=8800 npm run identity:sink
 */

import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, process.env.IDENTITY_RUN_SINK_DIR || '.cursor/identity_runs');
const PORT = Number(process.env.IDENTITY_RUN_SINK_PORT || 8799);
const HOST = '127.0.0.1';

await mkdir(OUT_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
	const okCors = () => {
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
		res.setHeader('access-control-allow-headers', 'content-type');
	};

	if (req.method === 'OPTIONS') {
		okCors();
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.method === 'POST' && (req.url === '/identity-runs' || req.url?.startsWith('/identity-runs?'))) {
		okCors();
		try {
			const chunks = [];
			for await (const chunk of req) {
				chunks.push(chunk);
			}
			const raw = Buffer.concat(chunks).toString('utf8');
			const body = JSON.parse(raw);
			const id = typeof body?.identity_run_id === 'string' ? body.identity_run_id.trim() : '';
			if (!id || id.includes('/') || id.includes('..')) {
				res.writeHead(400, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ error: 'identity_run_id required' }));
				return;
			}
			const path = resolve(OUT_DIR, `${id}.json`);
			await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
			console.log(`[identity-run-sink] wrote ${path}`);
			res.writeHead(204);
			res.end();
		} catch (err) {
			console.error('[identity-run-sink] failed', err);
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
		}
		return;
	}

	if (req.method === 'GET' && req.url === '/health') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ ok: true, out_dir: OUT_DIR }));
		return;
	}

	res.writeHead(404);
	res.end('not found');
});

server.listen(PORT, HOST, () => {
	console.log(`[identity-run-sink] listening on http://${HOST}:${PORT}/identity-runs`);
	console.log(`[identity-run-sink] writing to ${OUT_DIR}`);
});
