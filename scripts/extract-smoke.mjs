#!/usr/bin/env node
/**
 * Preliminary outfit-extract smoke test against local photos.
 * Uses the same Claude prompt + json_schema shape as production (LLM only — no Florence/SAM).
 *
 * Usage:
 *   node scripts/extract-smoke.mjs
 *   node scripts/extract-smoke.mjs /path/to/outfits-set-v1 img1.jpg img2.jpg
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DEFAULT_SET = resolve(ROOT, '../outfits-set-v1');
/** Writable under the API workspace (gitignored via tmp/). */
const OUT_DIR = join(ROOT, 'tmp/extract_smoke');
const MAX_SIDE = 1280;

const SYSTEM_PROMPT = `
Analyze this outfit image and extract each visible clothing item.

Return a JSON object with this exact shape:
{
  "items": [
    {
      "label": "descriptive name e.g. black leather bomber jacket",
      "category": "top" | "bottom" | "outerwear" | "footwear" | "full-body" | "accessory",
      "subcategory": "valid subcategory mapping (see allowed list below)",
      "color": "primary color as a plain word e.g. black, navy, olive",
      "pattern": "solid" | "striped" | "checked" | "graphic" | "camo" | "floral" | "other",
      "style_tags": ["2-3 tags e.g. streetwear, casual, formal"],
      "confidence": "high" | "medium" | "low",
      "bounding_box": {
        "x": left edge as % of THIS image's width (0-100, one decimal),
        "y": top edge as % of THIS image's height (0-100, one decimal),
        "width": item width as % of THIS image's width (0-100, one decimal),
        "height": item height as % of THIS image's height (0-100, one decimal)
      }
    }
  ]
}

Classification Rules for Category & Subcategory:
- If category is "top", subcategory MUST be one of: "t-shirt" | "shirt" | "sweater" | "hoodie" | "sweatshirt" | "tank-top" | "polo" | "crop-top"
- If category is "bottom", subcategory MUST be one of: "jeans" | "pants" | "shorts" | "skirt" | "sweatpants" | "leggings"
- If category is "outerwear", subcategory MUST be one of: "jacket" | "coat" | "blazer" | "vest" | "cardigan"
- If category is "footwear", subcategory MUST be one of: "sneakers" | "boots" | "loafers" | "heels" | "flats" | "sandals" | "slippers"
- If category is "full-body", subcategory MUST be one of: "dress" | "jumpsuit" | "suit"
- If category is "accessory", subcategory MUST be one of: "bag" | "jewelry" | "hat" | "eyewear" | "belt" | "scarf" | "watch" | "socks" | "gloves"
- Fallback subcategory: "other" (use only if no specific subcategory fits)

Extraction Rules:
- Only include items that are clearly part of the outfit being worn.
- Bounding boxes MUST tightly wrap only that garment's visible pixels (sleeves, collar, hems, cuffs).
- Do NOT include walls, floors, elevator panels, mirrors, phones, or empty space. The person may be off-center; measure percents against the full image, not the person crop.
- One item per box. Overlapping layers (open shirt over a tee) get separate boxes; each box should cover that layer only, even if another garment shows through.
- Do not include items in the background or held objects unless they are accessories being worn (skip phones).
- "confidence": "high" if clearly visible, "medium" if partially visible/obstructed, "low" if heavily obscured or uncertain.
- If no outfit is visible, return { "items": [] }.
- Return JSON only. No explanation, no markdown, no code fences.
`.trim();

const SCHEMA = {
	type: 'object',
	properties: {
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					label: { type: 'string' },
					category: {
						type: 'string',
						enum: ['top', 'bottom', 'outerwear', 'footwear', 'accessory', 'full-body'],
					},
					subcategory: {
						type: 'string',
						enum: [
							't-shirt',
							'shirt',
							'sweater',
							'hoodie',
							'sweatshirt',
							'tank-top',
							'polo',
							'crop-top',
							'jeans',
							'pants',
							'shorts',
							'skirt',
							'sweatpants',
							'leggings',
							'jacket',
							'coat',
							'blazer',
							'vest',
							'cardigan',
							'sneakers',
							'boots',
							'loafers',
							'heels',
							'flats',
							'sandals',
							'slippers',
							'dress',
							'jumpsuit',
							'suit',
							'bag',
							'jewelry',
							'hat',
							'eyewear',
							'belt',
							'scarf',
							'watch',
							'socks',
							'gloves',
							'other',
						],
					},
					color: { type: 'string' },
					pattern: {
						type: 'string',
						enum: ['solid', 'striped', 'checked', 'graphic', 'camo', 'floral', 'other'],
					},
					style_tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
					confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
					bounding_box: {
						type: 'object',
						properties: {
							x: { type: 'number' },
							y: { type: 'number' },
							width: { type: 'number' },
							height: { type: 'number' },
						},
						required: ['x', 'y', 'width', 'height'],
						additionalProperties: false,
					},
				},
				required: [
					'label',
					'category',
					'subcategory',
					'color',
					'pattern',
					'style_tags',
					'confidence',
					'bounding_box',
				],
				additionalProperties: false,
			},
		},
	},
	required: ['items'],
	additionalProperties: false,
};

const DEFAULT_FILES = [
	'IMG_3009.jpg', // outdoor leather + jeans
	'B016F629-2536-4E9D-A065-795EF80F88C4_1_102_o.jpeg', // mirror hoodie
	'IMG_0379.JPG', // indoor beige quarter-zip
];

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

function sipsGet(path, key) {
	const out = execFileSync('sips', ['-g', key, path], { encoding: 'utf8' });
	const m = out.match(new RegExp(`${key}:\\s*(\\d+)`));
	if (!m) throw new Error(`sips missing ${key} for ${path}`);
	return Number(m[1]);
}

function prepareJpeg(srcPath, destPath) {
	execFileSync('sips', ['-s', 'format', 'jpeg', srcPath, '--out', destPath], {
		stdio: 'ignore',
	});
	const w = sipsGet(destPath, 'pixelWidth');
	const h = sipsGet(destPath, 'pixelHeight');
	const long = Math.max(w, h);
	if (long > MAX_SIDE) {
		if (w >= h) {
			execFileSync('sips', ['--resampleWidth', String(MAX_SIDE), destPath], { stdio: 'ignore' });
		} else {
			execFileSync('sips', ['--resampleHeight', String(MAX_SIDE), destPath], { stdio: 'ignore' });
		}
	}
	return {
		width: sipsGet(destPath, 'pixelWidth'),
		height: sipsGet(destPath, 'pixelHeight'),
	};
}

function userPrompt(width, height) {
	const aspect = width >= height ? 'landscape' : 'portrait';
	return [
		`The attached JPEG is already EXIF-oriented (same pixels a phone gallery would show).`,
		`It is ${width}px wide × ${height}px tall (${aspect}). Origin is the top-left of this JPEG.`,
		`bounding_box is xywh as a percentage of THIS ${width}×${height} image — not of a square pad and not of a crop around the person.`,
		`Use one decimal place (e.g. 18.6). Do not round to 5 or 10.`,
		`A hat or cap sits on the head; y is 0 only if that item actually touches the top edge of the photo.`,
		`Extract all clothing items from this image.`,
	].join(' ');
}

function summarizeItems(items) {
	return (items || []).map((it) => ({
		label: it.label,
		category: it.category,
		subcategory: it.subcategory,
		color: it.color,
		confidence: it.confidence,
		box: it.bounding_box,
	}));
}

function boxSanity(items) {
	const notes = [];
	for (const it of items || []) {
		const b = it.bounding_box;
		if (!b) {
			notes.push(`${it.label}: missing box`);
			continue;
		}
		const right = b.x + b.width;
		const bottom = b.y + b.height;
		if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0) {
			notes.push(`${it.label}: non-positive or negative box`);
		}
		if (right > 100.5 || bottom > 100.5) {
			notes.push(`${it.label}: box exceeds image (${right.toFixed(1)}×${bottom.toFixed(1)})`);
		}
		if (b.width > 95 && b.height > 95) {
			notes.push(`${it.label}: box covers almost entire frame`);
		}
	}
	return notes;
}

async function extractOne({ endpoint, apiKey, model, srcPath, workDir }) {
	const stem = basename(srcPath, extname(srcPath));
	const hash = createHash('sha1').update(srcPath).digest('hex').slice(0, 8);
	const jpegPath = join(workDir, `${stem}_${hash}.jpg`);
	const dims = prepareJpeg(srcPath, jpegPath);
	const bytes = await readFile(jpegPath);
	const mediaType = 'image/jpeg';
	const data = bytes.toString('base64');

	const body = {
		model,
		max_tokens: 2048,
		system: SYSTEM_PROMPT,
		messages: [
			{
				role: 'user',
				content: [
					{
						type: 'image',
						source: { type: 'base64', media_type: mediaType, data },
					},
					{ type: 'text', text: userPrompt(dims.width, dims.height) },
				],
			},
		],
		output_config: {
			format: {
				type: 'json_schema',
				schema: SCHEMA,
			},
		},
	};

	const started = Date.now();
	const res = await fetch(`${endpoint.replace(/\/$/, '')}/messages`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify(body),
	});
	const elapsedMs = Date.now() - started;
	const raw = await res.json().catch(() => ({}));
	if (!res.ok) {
		const msg = raw?.error?.message || `${res.status} ${res.statusText}`;
		throw new Error(msg);
	}

	const text = (raw.content || [])
		.filter((c) => c.type === 'text')
		.map((c) => c.text)
		.join('\n');
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Model returned non-JSON: ${text.slice(0, 200)}`);
	}

	return {
		file: basename(srcPath),
		path: srcPath,
		model,
		elapsed_ms: elapsedMs,
		image: dims,
		input_tokens: raw.usage?.input_tokens ?? null,
		output_tokens: raw.usage?.output_tokens ?? null,
		item_count: parsed.items?.length ?? 0,
		items: parsed.items ?? [],
		box_notes: boxSanity(parsed.items),
		summary: summarizeItems(parsed.items),
	};
}

async function main() {
	const args = process.argv.slice(2);
	const setDir = resolve(args[0] && !args[0].endsWith('.jpg') && !args[0].endsWith('.jpeg') && !args[0].endsWith('.JPG')
		? args.shift()
		: DEFAULT_SET);
	const files = (args.length ? args : DEFAULT_FILES).map((f) => (f.includes('/') ? resolve(f) : join(setDir, f)));

	const env = parseDevVars(await readFile(join(ROOT, '.dev.vars'), 'utf8'));
	const endpoint = env.CLAUDE_ENDPOINT_URL;
	const apiKey = env.CLAUDE_API_KEY;
	const model = env.CLAUDE_OUTFIT_EXTRACTION_MODEL_VERSION;
	if (!endpoint || !apiKey || !model || apiKey === 'dummy' || model === 'dummy') {
		throw new Error('Need real CLAUDE_ENDPOINT_URL, CLAUDE_API_KEY, CLAUDE_OUTFIT_EXTRACTION_MODEL_VERSION in .dev.vars');
	}

	await mkdir(OUT_DIR, { recursive: true });
	const workDir = join(OUT_DIR, 'work');
	await mkdir(workDir, { recursive: true });

	console.log(`Extract smoke — model=${model}`);
	console.log(`Set: ${setDir}`);
	console.log(`Photos: ${files.map((f) => basename(f)).join(', ')}`);
	console.log('(LLM extract only — no Florence grounding / identity)\n');

	const results = [];
	for (const srcPath of files) {
		process.stdout.write(`→ ${basename(srcPath)} ... `);
		try {
			const result = await extractOne({ endpoint, apiKey, model, srcPath, workDir });
			results.push({ ok: true, ...result });
			console.log(`${result.item_count} items in ${result.elapsed_ms}ms`);
			for (const row of result.summary) {
				console.log(
					`   - [${row.confidence}] ${row.category}/${row.subcategory} ${row.color}: ${row.label}`
				);
			}
			if (result.box_notes.length) {
				console.log(`   box notes: ${result.box_notes.join('; ')}`);
			}
		} catch (err) {
			results.push({ ok: false, file: basename(srcPath), path: srcPath, error: String(err?.message || err) });
			console.log(`FAIL: ${err?.message || err}`);
		}
		console.log('');
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const outPath = join(OUT_DIR, `smoke_${stamp}.json`);
	await writeFile(
		outPath,
		JSON.stringify(
			{
				ran_at: new Date().toISOString(),
				model,
				note: 'Preliminary extract smoke — not a scored eval; no grounding/identity.',
				results,
			},
			null,
			2
		)
	);
	console.log(`Wrote ${outPath}`);

	const ok = results.filter((r) => r.ok).length;
	const fail = results.length - ok;
	console.log(`Done: ${ok} ok, ${fail} failed`);
	if (fail) process.exitCode = 1;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
