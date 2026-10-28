#!/usr/bin/env node
/**
 * Reset closet / identity state for EVAL_USER_ID (start of an eval cycle).
 *
 * Requires: npm run dev, EVAL_USER_ID + ADMIN_API_KEY in .dev.vars
 *
 *   npm run eval:reset
 *   node scripts/eval-reset.mjs [userId]
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

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

async function main() {
	const env = parseDevVars(await readFile(join(ROOT, '.dev.vars'), 'utf8'));
	const base = (env.EVAL_API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
	const adminKey = env.ADMIN_API_KEY;
	const userId = (process.argv[2] || env.EVAL_USER_ID || '').trim();

	if (!adminKey || adminKey === 'dummy') {
		throw new Error('ADMIN_API_KEY missing/dummy in .dev.vars');
	}
	if (!userId) {
		throw new Error('EVAL_USER_ID missing — set in .dev.vars or pass as argv');
	}

	const res = await fetch(`${base}/closet/eval/reset`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-admin-api-key': adminKey,
		},
		body: JSON.stringify({ userId }),
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text };
	}
	if (!res.ok) {
		console.error(`Reset failed (${res.status}):`, body);
		process.exit(1);
	}
	console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
