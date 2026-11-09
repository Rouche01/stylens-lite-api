#!/usr/bin/env node
/**
 * Eval-cycle smoke: reset EVAL_USER_ID once, then upload each fixture and call
 * the real POST /outfits/extract path (orient → LLM → grounding → identity).
 *
 * Requires: npm run dev, ADMIN_API_KEY, EVAL_USER_ID in .dev.vars
 *
 *   npm run extract:smoke
 *   npm run extract:smoke -- --no-reset
 *   npm run extract:smoke -- --reuse-extract
 *   npm run extract:smoke -- --reuse-extract --bust-extract-cache
 *   npm run extract:smoke -- /path/to/outfits-set-v1 img1.jpg img2.jpg
 *
 * Probe artifacts (admin extract only): each item may include `identity_probe`
 * (encoder, vector, crop_color, crop_image_key). Crops are downloaded under
 * tmp/extract_smoke/work/<stamp>/crops/ for offline replay.
 *
 * --reuse-extract: skip Claude+grounding when a cache hit exists for
 *   sha256(image bytes) + prompt/schema version (see extract_cache/).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_SET = resolve(ROOT, '../outfits-set-v1');
const OUT_DIR = join(ROOT, 'tmp/extract_smoke');
const EXTRACT_CACHE_DIR = join(OUT_DIR, 'extract_cache');
const PROMPT_PATHS = [
	join(ROOT, 'src/llm/prompts/outfit_extraction.ts'),
	join(ROOT, 'src/llm/schemas/outfit_extraction.schema.ts'),
];

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
		reuseExtract: flags.has('--reuse-extract'),
		bustExtractCache: flags.has('--bust-extract-cache'),
		setDir,
		files: files.map((f) => (f.includes('/') || f.startsWith('.') ? resolve(f) : join(setDir, f))),
	};
}

function sha256Hex(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

async function resolvePromptVersion(env) {
	const parts = [];
	for (const path of PROMPT_PATHS) {
		try {
			parts.push(await readFile(path, 'utf8'));
		} catch {
			parts.push(`missing:${basename(path)}`);
		}
	}
	const model =
		env.ANTHROPIC_OUTFIT_EXTRACTION_MODEL_VERSION ||
		env.OPENAI_OUTFIT_EXTRACTION_MODEL_VERSION ||
		env.OUTFIT_EXTRACTION_MODEL ||
		'';
	parts.push(`model:${model}`);
	return sha256Hex(parts.join('\n')).slice(0, 16);
}

function extractCachePath(imageSha, promptVersion) {
	return join(EXTRACT_CACHE_DIR, `${imageSha.slice(0, 24)}_${promptVersion}.json`);
}

async function loadExtractCache(imageSha, promptVersion) {
	const path = extractCachePath(imageSha, promptVersion);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		if (parsed?.image_sha256 !== imageSha || parsed?.prompt_version !== promptVersion) return null;
		if (!parsed.extraction || !Array.isArray(parsed.extraction.items)) return null;
		const dims = parsed.extraction.image_dimensions;
		if (!dims || typeof dims.width !== 'number' || typeof dims.height !== 'number') return null;
		return { path, extraction: parsed.extraction };
	} catch {
		return null;
	}
}

async function saveExtractCache({ imageSha, promptVersion, sourceFile, extraction }) {
	await mkdir(EXTRACT_CACHE_DIR, { recursive: true });
	const path = extractCachePath(imageSha, promptVersion);
	const payload = {
		version: 1,
		image_sha256: imageSha,
		prompt_version: promptVersion,
		source_file: sourceFile,
		cached_at: new Date().toISOString(),
		extraction: {
			items: extraction.items,
			item_count: extraction.item_count ?? extraction.items.length,
			image_dimensions: extraction.image_dimensions,
			extracted_at: extraction.extracted_at ?? new Date().toISOString(),
			// image_url is rewritten on reuse to the current upload
			image_url: extraction.image_url ?? '',
		},
	};
	await writeFile(path, JSON.stringify(payload, null, 2));
	return path;
}

/** Strip identity/probe fields so the cache stays a pure extraction snapshot. */
function extractionFromExtractResponse(body) {
	const items = (Array.isArray(body?.items) ? body.items : []).map((it) => ({
		label: it.label,
		category: it.category,
		subcategory: it.subcategory,
		color: it.color,
		pattern: it.pattern,
		style_tags: it.style_tags || [],
		confidence: it.confidence,
		bounding_box: it.bounding_box,
	}));
	return {
		items,
		item_count: items.length,
		image_url: body?.image_url || '',
		extracted_at: body?.extracted_at || new Date().toISOString(),
		image_dimensions: body?.image_dimensions || null,
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
		identity_cosine: it.identity_cosine ?? null,
		identity_color_distance: it.identity_color_distance ?? null,
		closet_item_id: it.closet_item_id ?? null,
		candidate_closet_item_id: it.candidate_closet_item_id ?? null,
		match_id: it.match_id ?? null,
		box: it.bounding_box ?? null,
		has_probe: Boolean(it.identity_probe?.vector?.length),
		probe_encoder: it.identity_probe?.encoder ?? null,
		crop_path: it.identity_probe?.crop_path ?? null,
	}));
}

/** Persist crop JPEG locally; strip ephemeral signed URL from the stored probe. */
async function materializeProbe(item, index, cropsDir) {
	const probe = item?.identity_probe;
	if (!probe || !Array.isArray(probe.vector) || probe.vector.length === 0) {
		return { ...item, identity_probe: probe ?? null };
	}

	const safeFile = String(item.label || `item_${index}`)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_|_$/g, '')
		.slice(0, 40);
	const cropName = `${String(index).padStart(2, '0')}_${safeFile || 'crop'}.jpg`;
	const cropAbs = join(cropsDir, cropName);
	let cropPath = null;
	const url = typeof probe.crop_image_url === 'string' ? probe.crop_image_url.trim() : '';
	if (url) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			const bytes = Buffer.from(await res.arrayBuffer());
			await writeFile(cropAbs, bytes);
			cropPath = relative(ROOT, cropAbs);
		} catch (err) {
			console.warn(`   ! crop download failed for item ${index}: ${err?.message || err}`);
		}
	}

	const { crop_image_url: _omitUrl, ...rest } = probe;
	return {
		...item,
		identity_probe: {
			...rest,
			crop_path: cropPath,
		},
	};
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

async function extractOutfit({ base, adminKey, userId, imageKey, imageUrl, cachedExtraction }) {
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
			...(cachedExtraction ? { cachedExtraction } : {}),
		}),
	});
	const elapsedMs = Date.now() - started;
	const { body, text } = await readJsonResponse(res);
	if (!res.ok) {
		throw new Error(`extract failed: ${errorMessage(body, res.status, res.statusText)} (${text.slice(0, 240)})`);
	}
	return { body, elapsedMs, reusedExtract: Boolean(cachedExtraction) };
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
	const { noReset, reuseExtract, bustExtractCache, setDir, files } = parseArgs(process.argv.slice(2));
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
	const promptVersion = await resolvePromptVersion(env);

	console.log(`API extract smoke — ${base}`);
	console.log(`Eval user: ${userId}`);
	console.log(`Set: ${setDir}`);
	console.log(`Photos (${files.length}): ${files.map((f) => basename(f)).join(', ')}`);
	console.log(
		reuseExtract
			? `Extract cache: reuse on (prompt=${promptVersion}${bustExtractCache ? ', bust' : ''})`
			: 'Extract cache: write-through (pass --reuse-extract to skip Claude on hits)'
	);
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

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const workDir = join(OUT_DIR, 'work', stamp);
	const cropsRoot = join(workDir, 'crops');
	await mkdir(cropsRoot, { recursive: true });

	const results = [];
	let probeCount = 0;
	let cropCount = 0;
	let extractCacheHits = 0;
	let extractCacheMisses = 0;
	for (const srcPath of files) {
		const file = basename(srcPath);
		process.stdout.write(`→ ${file} ... `);
		try {
			const bytes = await readFile(srcPath);
			const imageSha = sha256Hex(bytes);
			let cachedExtraction = null;
			if (reuseExtract && !bustExtractCache) {
				const hit = await loadExtractCache(imageSha, promptVersion);
				if (hit) {
					cachedExtraction = {
						...hit.extraction,
						image_url: '', // filled after upload
					};
					extractCacheHits += 1;
				} else {
					extractCacheMisses += 1;
				}
			} else if (reuseExtract && bustExtractCache) {
				extractCacheMisses += 1;
			}

			const uploaded = await uploadPhoto({ base, srcPath });
			if (cachedExtraction) {
				cachedExtraction = {
					...cachedExtraction,
					image_url: uploaded.imageUrl || cachedExtraction.image_url || '',
				};
			}
			const { body, elapsedMs, reusedExtract } = await extractOutfit({
				base,
				adminKey,
				userId,
				imageKey: uploaded.imageKey,
				imageUrl: uploaded.imageUrl,
				cachedExtraction,
			});

			// Always refresh cache from a live extract; on reuse keep existing entry.
			if (!reusedExtract) {
				const snap = extractionFromExtractResponse(body);
				if (snap.image_dimensions && snap.items.length) {
					await saveExtractCache({
						imageSha,
						promptVersion,
						sourceFile: file,
						extraction: snap,
					});
				}
			}

			const rawItems = Array.isArray(body?.items) ? body.items : [];
			const photoCropsDir = join(cropsRoot, file.replace(/[^\w.-]+/g, '_'));
			await mkdir(photoCropsDir, { recursive: true });
			const items = [];
			for (let i = 0; i < rawItems.length; i++) {
				const next = await materializeProbe(rawItems[i], i, photoCropsDir);
				if (next.identity_probe?.vector?.length) probeCount += 1;
				if (next.identity_probe?.crop_path) cropCount += 1;
				items.push(next);
			}
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
			results.push({ ...result, extract_reused: reusedExtract, image_sha256: imageSha });
			const reuseBit = reusedExtract ? ' extract=cache' : '';
			console.log(
				`${result.item_count} items in ${elapsedMs}ms (outfit=${result.outfit_id || '—'})${reuseBit}`
			);
			for (const row of result.summary) {
				const idBit = row.identity_status
					? ` identity=${row.identity_status}${row.identity_score != null ? `@${Number(row.identity_score).toFixed(3)}` : ''}`
					: '';
				const diagBits = [];
				if (row.identity_cosine != null) diagBits.push(`cos=${Number(row.identity_cosine).toFixed(3)}`);
				if (row.identity_color_distance != null) {
					diagBits.push(`color_d=${Number(row.identity_color_distance).toFixed(3)}`);
				}
				if (row.has_probe) diagBits.push('probe');
				const diag = diagBits.length ? ` [${diagBits.join(' ')}]` : '';
				console.log(
					`   - [${row.confidence}] ${row.category}/${row.subcategory} ${row.color}: ${row.label}${idBit}${diag}`
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
				work_dir: relative(ROOT, workDir),
				probe_count: probeCount,
				crop_count: cropCount,
				extract_cache: {
					enabled: reuseExtract,
					bust: bustExtractCache,
					prompt_version: promptVersion,
					hits: extractCacheHits,
					misses: extractCacheMisses,
					dir: relative(ROOT, EXTRACT_CACHE_DIR),
				},
				note: 'Full POST /outfits/extract cycle. Closet accumulates across photos; reset only at cycle start. Admin extract includes identity_probe; crops under work_dir/crops/. Pass --reuse-extract to skip Claude on cache hits.',
				results,
			},
			null,
			2
		)
	);

	console.log(`Wrote ${outPath}`);
	console.log(`Probes: ${probeCount} · crops saved: ${cropCount} → ${relative(ROOT, cropsRoot)}`);
	if (reuseExtract) {
		console.log(`Extract cache: ${extractCacheHits} hit · ${extractCacheMisses} miss (${relative(ROOT, EXTRACT_CACHE_DIR)})`);
	}
	console.log(`Done: ${ok} ok, ${fail} failed`);
	console.log('Tip: npm run eval:ui  ·  npm run identity:replay');
	if (fail) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
