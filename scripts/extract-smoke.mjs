#!/usr/bin/env node
/**
 * Eval-cycle smoke: reset EVAL_USER_ID once, then upload each fixture and call
 * the real POST /outfits/extract path (orient → LLM → grounding → identity).
 *
 * Requires: npm run dev, ADMIN_API_KEY, EVAL_USER_ID in .dev.vars
 *
 *   npm run extract:smoke
 *   npm run extract:smoke -- --no-reset
 *   npm run extract:smoke -- /path/to/outfits-set-v1 img1.jpg img2.jpg
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_SET = resolve(ROOT, '../outfits-set-v1');
const OUT_DIR = join(ROOT, 'tmp/extract_smoke');

const DEFAULT_FILES = [
	'IMG_3009.jpg',
	'B016F629-2536-4E9D-A065-795EF80F88C4_1_102_o.jpeg',
	'IMG_0379.JPG',
];

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG', '.WEBP']);

/** Let local queue consumers + Vectorize delete lag settle before first extract. */
const POST_RESET_SETTLE_MS = 5_000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDevVars(text) {
	const out = {};
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

function contentTypeFor(path) {
	switch (extname(path).toLowerCase()) {
		case '.png':
			return 'image/png';
		case '.webp':
			return 'image/webp';
		default:
			return 'image/jpeg';
	}
}

function parseArgs(argv) {
	const flags = new Set();
	const positional = [];
	for (const arg of argv) {
		if (arg.startsWith('--')) flags.add(arg);
		else positional.push(arg);
	}

	let setDir = DEFAULT_SET;
	let files = [...DEFAULT_FILES];
	if (positional.length > 0) {
		const first = positional[0];
		const firstIsDirLike = !IMAGE_EXT.has(extname(first));
		if (firstIsDirLike) {
			setDir = resolve(first);
			files = positional.slice(1);
		} else {
			files = positional;
		}
		if (files.length === 0) files = [...DEFAULT_FILES];
	}

	return {
		noReset: flags.has('--no-reset'),
		setDir,
		files: files.map((f) => (f.includes('/') || f.startsWith('.') ? resolve(f) : join(setDir, f))),
	};
}

function errorMessage(body, status, statusText) {
	if (body && typeof body === 'object') {
		if (typeof body.error === 'string') return body.error;
		if (typeof body.error?.message === 'string') return body.error.message;
		if (typeof body.message === 'string') return body.message;
	}
	return `${status} ${statusText}`;
}

async function readJsonResponse(res) {
	const text = await res.text();
	try {
		return { body: JSON.parse(text), text };
	} catch {
		return { body: null, text };
	}
}

function summarizeItems(items) {
	return (items || []).map((it) => ({
		label: it.label,
		category: it.category,
		subcategory: it.subcategory,
		color: it.color,
		confidence: it.confidence,
		identity_status: it.identity_status ?? null,
		identity_reason: it.identity_reason ?? null,
		identity_score: it.identity_score ?? null,
		closet_item_id: it.closet_item_id ?? null,
		candidate_closet_item_id: it.candidate_closet_item_id ?? null,
		match_id: it.match_id ?? null,
		box: it.bounding_box ?? null,
	}));
}

async function resetEvalUser({ base, adminKey, userId }) {
	const res = await fetch(`${base}/closet/eval/reset`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-admin-api-key': adminKey,
		},
		body: JSON.stringify({ userId }),
	});
	const { body, text } = await readJsonResponse(res);
	if (!res.ok) {
		throw new Error(`eval reset failed: ${errorMessage(body, res.status, res.statusText)} (${text.slice(0, 200)})`);
	}
	return body;
}

async function uploadPhoto({ base, srcPath }) {
	const filename = basename(srcPath);
	const urlRes = await fetch(`${base}/assets/upload-url?filename=${encodeURIComponent(filename)}`);
	const { body: urls, text: urlText } = await readJsonResponse(urlRes);
	if (!urlRes.ok || !urls?.uploadUrl || !urls?.filename) {
		throw new Error(
			`upload-url failed: ${errorMessage(urls, urlRes.status, urlRes.statusText)} (${urlText.slice(0, 200)})`
		);
	}

	const bytes = await readFile(srcPath);
	const putRes = await fetch(urls.uploadUrl, {
		method: 'PUT',
		headers: { 'Content-Type': contentTypeFor(srcPath) },
		body: bytes,
	});
	if (!putRes.ok) {
		const putText = await putRes.text().catch(() => '');
		throw new Error(`R2 PUT failed: ${putRes.status} ${putRes.statusText} ${putText.slice(0, 200)}`);
	}

	return {
		imageKey: urls.filename,
		imageUrl: urls.downloadUrl || null,
	};
}

async function extractOutfit({ base, adminKey, userId, imageKey, imageUrl }) {
	const started = Date.now();
	const res = await fetch(`${base}/outfits/extract`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-admin-api-key': adminKey,
		},
		body: JSON.stringify({
			userId,
			imageKey,
			...(imageUrl ? { imageUrl } : {}),
		}),
	});
	const elapsedMs = Date.now() - started;
	const { body, text } = await readJsonResponse(res);
	if (!res.ok) {
		throw new Error(`extract failed: ${errorMessage(body, res.status, res.statusText)} (${text.slice(0, 240)})`);
	}
	return { body, elapsedMs };
}

async function probeApi(base) {
	try {
		const res = await fetch(`${base}/`, { method: 'GET' });
		return res.status;
	} catch (err) {
		throw new Error(
			`Cannot reach API at ${base} — start wrangler with npm run dev. (${err?.message || err})`
		);
	}
}

async function main() {
	const { noReset, setDir, files } = parseArgs(process.argv.slice(2));
	const env = parseDevVars(await readFile(join(ROOT, '.dev.vars'), 'utf8'));
	const base = (env.EVAL_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
	const adminKey = env.ADMIN_API_KEY;
	const userId = (env.EVAL_USER_ID || '').trim();

	if (!adminKey || adminKey === 'dummy') {
		throw new Error('ADMIN_API_KEY missing/dummy in .dev.vars');
	}
	if (!userId) {
		throw new Error('EVAL_USER_ID missing — set a dedicated sandbox user id in .dev.vars');
	}

	await probeApi(base);
	await mkdir(OUT_DIR, { recursive: true });

	console.log(`API extract smoke — ${base}`);
	console.log(`Eval user: ${userId}`);
	console.log(`Set: ${setDir}`);
	console.log(`Photos (${files.length}): ${files.map((f) => basename(f)).join(', ')}`);
	console.log(noReset ? 'Reset: skipped (--no-reset)\n' : 'Reset: once at cycle start\n');

	let resetResult = null;
	if (!noReset) {
		process.stdout.write('→ reset eval user ... ');
		resetResult = await resetEvalUser({ base, adminKey, userId });
		console.log(
			`ok (closet_items=${resetResult?.d1?.closet_items ?? '?'}, vectors_deleted=${resetResult?.vectors_deleted ?? '?'})`
		);
		process.stdout.write(`→ settle ${POST_RESET_SETTLE_MS}ms (drain stale queue jobs) ... `);
		await sleep(POST_RESET_SETTLE_MS);
		console.log('ok');
		resetResult = { ...resetResult, settle_ms: POST_RESET_SETTLE_MS };
		console.log('');
	}

	const results = [];
	for (const srcPath of files) {
		const file = basename(srcPath);
		process.stdout.write(`→ ${file} ... `);
		try {
			const uploaded = await uploadPhoto({ base, srcPath });
			const { body, elapsedMs } = await extractOutfit({
				base,
				adminKey,
				userId,
				imageKey: uploaded.imageKey,
				imageUrl: uploaded.imageUrl,
			});
			const items = Array.isArray(body?.items) ? body.items : [];
			const result = {
				ok: true,
				file,
				path: srcPath,
				elapsed_ms: elapsedMs,
				outfit_id: body?.outfit_id ?? null,
				image_key: uploaded.imageKey,
				image_url: uploaded.imageUrl,
				image_dimensions: body?.image_dimensions ?? null,
				item_count: items.length,
				items,
				summary: summarizeItems(items),
			};
			results.push(result);
			console.log(`${result.item_count} items in ${elapsedMs}ms (outfit=${result.outfit_id || '—'})`);
			for (const row of result.summary) {
				const idBit = row.identity_status
					? ` identity=${row.identity_status}${row.identity_score != null ? `@${Number(row.identity_score).toFixed(3)}` : ''}`
					: '';
				console.log(
					`   - [${row.confidence}] ${row.category}/${row.subcategory} ${row.color}: ${row.label}${idBit}`
				);
			}
		} catch (err) {
			results.push({
				ok: false,
				file,
				path: srcPath,
				error: String(err?.message || err),
			});
			console.log(`FAIL: ${err?.message || err}`);
		}
		console.log('');
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outPath = join(OUT_DIR, `smoke_${stamp}.json`);
	const ok = results.filter((r) => r.ok).length;
	const fail = results.length - ok;
	await writeFile(
		outPath,
		JSON.stringify(
			{
				ran_at: new Date().toISOString(),
				source: 'api_extract',
				api_base: base,
				user_id: userId,
				reset: noReset ? null : resetResult,
				note: 'Full POST /outfits/extract cycle. Closet accumulates across photos; reset only at cycle start.',
				results,
			},
			null,
			2
		)
	);

	console.log(`Wrote ${outPath}`);
	console.log(`Done: ${ok} ok, ${fail} failed`);
	console.log('Tip: npm run eval:ui  ·  npm run identity:sink (optional run artifacts)');
	if (fail) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
