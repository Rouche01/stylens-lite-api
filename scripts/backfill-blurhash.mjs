#!/usr/bin/env node
/**
 * Backfill BlurHash metadata for existing R2 outfit photos.
 *
 * Reads distinct image keys from D1 that are missing blur_hash / image_blur_hash,
 * fetches each object from R2, encodes a 4x3 BlurHash (same as the Flutter client),
 * and UPDATEs D1 rows. Does not modify R2 objects.
 *
 * Usage:
 *   node scripts/backfill-blurhash.mjs [--local|--remote] [--env staging|production]
 *     [--dry-run] [--limit N] [--concurrency N] [--vars-file PATH]
 *
 * Requires:
 *   - Wrangler logged in (for D1)
 *   - R2 S3 credentials in .dev.vars (or --vars-file):
 *       OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID
 *       OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY
 *       OUTFIT_PHOTOS_BUCKET_NAME
 *       R2_ACCOUNT_ID
 *   - npm packages: sharp, blurhash, aws4fetch (aws4fetch is already a dependency)
 *
 * Examples:
 *   node scripts/backfill-blurhash.mjs --local --dry-run --limit 5
 *   node scripts/backfill-blurhash.mjs --remote --env production --concurrency 4
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

function loadPkg(name) {
	try {
		return require(name);
	} catch {
		console.error(`Missing dependency "${name}". Install with:\n  npm i -D sharp blurhash`);
		process.exit(1);
	}
}

const sharp = loadPkg('sharp');
const { encode: encodeBlurHash } = loadPkg('blurhash');
const { AwsClient } = loadPkg('aws4fetch');

function parseArgs(argv) {
	const opts = {
		local: false,
		remote: false,
		env: null,
		dryRun: false,
		limit: null,
		concurrency: 3,
		varsFile: resolve(ROOT, '.dev.vars'),
		delayMs: 50,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--local') opts.local = true;
		else if (a === '--remote') opts.remote = true;
		else if (a === '--dry-run') opts.dryRun = true;
		else if (a === '--env') opts.env = argv[++i];
		else if (a === '--limit') opts.limit = Number(argv[++i]);
		else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
		else if (a === '--vars-file') opts.varsFile = resolve(argv[++i]);
		else if (a === '--delay-ms') opts.delayMs = Number(argv[++i]);
		else if (a === '--help' || a === '-h') {
			console.log(`See header comment in scripts/backfill-blurhash.mjs`);
			process.exit(0);
		} else {
			console.error(`Unknown arg: ${a}`);
			process.exit(1);
		}
	}

	if (!opts.local && !opts.remote) {
		opts.remote = true; // default: remote D1
	}
	if (opts.local && opts.remote) {
		console.error('Use only one of --local or --remote');
		process.exit(1);
	}
	return opts;
}

function loadDevVars(path) {
	if (!existsSync(path)) {
		console.error(`Vars file not found: ${path}`);
		process.exit(1);
	}
	const text = readFileSync(path, 'utf8');
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (!(key in process.env) || process.env[key] === '') {
			process.env[key] = value;
		}
	}
}

function sqlString(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

function wranglerD1(commandSql, opts) {
	const args = ['wrangler', 'd1', 'execute', 'GOSTYLENS_DB', '--json', '--command', commandSql];
	if (opts.local) args.push('--local');
	if (opts.remote) args.push('--remote');
	if (opts.env) args.push('--env', opts.env);

	const result = spawnSync('npx', args, {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 50 * 1024 * 1024,
	});

	if (result.status !== 0) {
		console.error(result.stderr || result.stdout);
		throw new Error(`wrangler d1 execute failed (exit ${result.status})`);
	}

	const stdout = result.stdout.trim();
	// Wrangler may print non-JSON noise; find the JSON payload.
	const start = stdout.indexOf('[');
	const end = stdout.lastIndexOf(']');
	if (start === -1 || end === -1) {
		throw new Error(`Could not parse wrangler JSON output:\n${stdout.slice(0, 500)}`);
	}
	const parsed = JSON.parse(stdout.slice(start, end + 1));
	return parsed;
}

function queryResults(parsed) {
	if (!Array.isArray(parsed) || parsed.length === 0) return [];
	return parsed[0]?.results ?? [];
}

async function fetchKeys(opts) {
	const sql = `
SELECT key FROM style_analysis_entry_images
WHERE blur_hash IS NULL AND key IS NOT NULL AND length(key) > 0
UNION
SELECT image_key AS key FROM style_analysis_histories
WHERE image_blur_hash IS NULL AND image_key IS NOT NULL AND length(image_key) > 0
`.replace(/\s+/g, ' ').trim();

	const rows = queryResults(wranglerD1(sql, opts));
	let keys = [...new Set(rows.map((r) => r.key).filter(Boolean))];
	if (opts.limit != null && Number.isFinite(opts.limit)) {
		keys = keys.slice(0, opts.limit);
	}
	return keys;
}

function createR2Client() {
	const accessKeyId = process.env.OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID;
	const secretAccessKey = process.env.OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY;
	const bucketName = process.env.OUTFIT_PHOTOS_BUCKET_NAME;
	const accountId = process.env.R2_ACCOUNT_ID;

	if (!accessKeyId || !secretAccessKey || !bucketName || !accountId) {
		console.error(
			'Missing R2 env. Need OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID, OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY, OUTFIT_PHOTOS_BUCKET_NAME, R2_ACCOUNT_ID'
		);
		process.exit(1);
	}
	if (accessKeyId === 'dummy' || secretAccessKey === 'dummy') {
		console.error('R2 credentials look like placeholders from .dev.vars.example — use real keys.');
		process.exit(1);
	}

	const client = new AwsClient({ accessKeyId, secretAccessKey });
	return { client, bucketName, accountId };
}

async function getObjectBytes(r2, key) {
	const url = new URL(`https://${r2.bucketName}.${r2.accountId}.r2.cloudflarestorage.com`);
	url.pathname = `/${key}`;
	const signed = await r2.client.sign(new Request(url.toString(), { method: 'GET' }), {
		aws: { signQuery: true },
	});
	const res = await fetch(signed.url);
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`R2 GET ${key} failed: ${res.status} ${res.statusText}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

async function encodeHashFromBytes(bytes) {
	const { data, info } = await sharp(bytes)
		.rotate()
		.resize(32, 32, { fit: 'inside', withoutEnlargement: true })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	return encodeBlurHash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
}

function updateD1ForKey(key, hash, opts) {
	const k = sqlString(key);
	const h = sqlString(hash);
	// Two statements: wrangler accepts one --command; run separately for compatibility.
	wranglerD1(
		`UPDATE style_analysis_entry_images SET blur_hash = ${h} WHERE key = ${k} AND blur_hash IS NULL`,
		opts
	);
	wranglerD1(
		`UPDATE style_analysis_histories SET image_blur_hash = ${h} WHERE image_key = ${k} AND image_blur_hash IS NULL`,
		opts
	);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function mapPool(items, concurrency, fn) {
	const results = [];
	let index = 0;

	async function worker() {
		while (index < items.length) {
			const i = index++;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	loadDevVars(opts.varsFile);

	console.log('BlurHash backfill');
	console.log(`  D1: ${opts.local ? 'local' : 'remote'}${opts.env ? ` (env=${opts.env})` : ''}`);
	console.log(`  dry-run: ${opts.dryRun}`);
	console.log(`  concurrency: ${opts.concurrency}`);
	console.log(`  vars: ${opts.varsFile}`);

	const keys = await fetchKeys(opts);
	console.log(`Found ${keys.length} key(s) missing BlurHash`);

	if (keys.length === 0) {
		console.log('Nothing to do.');
		return;
	}

	const r2 = createR2Client();
	console.log(`  R2 bucket: ${r2.bucketName}`);

	let ok = 0;
	let missing = 0;
	let failed = 0;

	await mapPool(keys, opts.concurrency, async (key, i) => {
		const label = `[${i + 1}/${keys.length}] ${key}`;
		try {
			const bytes = await getObjectBytes(r2, key);
			if (!bytes) {
				console.warn(`${label} — missing in R2, skipped`);
				missing++;
				return;
			}

			const hash = await encodeHashFromBytes(bytes);
			if (opts.dryRun) {
				console.log(`${label} — dry-run hash=${hash}`);
			} else {
				updateD1ForKey(key, hash, opts);
				console.log(`${label} — updated hash=${hash}`);
			}
			ok++;
			if (opts.delayMs > 0) await sleep(opts.delayMs);
		} catch (e) {
			failed++;
			console.error(`${label} — ERROR:`, e.message || e);
		}
	});

	console.log('\nDone.');
	console.log(`  ok: ${ok}`);
	console.log(`  missing R2: ${missing}`);
	console.log(`  failed: ${failed}`);
	if (opts.dryRun) console.log('  (dry-run — no D1 writes)');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
