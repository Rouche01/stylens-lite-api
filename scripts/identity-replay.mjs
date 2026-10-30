#!/usr/bin/env node
/**
 * Offline identity scoring replay over a smoke run with probes + ground-truth labels.
 *
 * Does not call Claude / Replicate / Vectorize. Uses stored identity_probe vectors
 * and crop_color, joined to garment_ids from labels.json / manifest.json.
 *
 *   npm run identity:replay
 *   npm run identity:replay -- --smoke tmp/extract_smoke/smoke_….json
 *   npm run identity:replay -- --sweep
 *   npm run identity:replay -- --ask-floor 0.5 --penalty 0.3 --auto-link 0.9
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SMOKE_DIR = join(ROOT, 'tmp/extract_smoke');
const LABELS_PATH = join(SMOKE_DIR, 'labels.json');
const DEFAULT_SET = resolve(ROOT, '../outfits-set-v1');
const MANIFEST_PATH = join(process.env.OUTFIT_EVAL_SET || DEFAULT_SET, 'manifest.json');

/** Mirrors src/services/identity/encode/cropColor.ts (keep in sync). */
const COLOR_DISTANCE_FULL_PENALTY = 0.3;
const COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL = 0.3;
const CHROMA_HUE_MIN_S = 0.12;
const IDENTITY_MATCH_MIN = 0.5;

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

const SUBCATEGORY_STRICT_SLOTS = new Set(['accessory', 'footwear']);

function parseArgs(argv) {
	const flags = new Set();
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--sweep') flags.add('sweep');
		else if (arg === '--smoke') opts.smoke = argv[++i];
		else if (arg === '--ask-floor') opts.askFloor = Number(argv[++i]);
		else if (arg === '--penalty') opts.penalty = Number(argv[++i]);
		else if (arg === '--auto-link') opts.autoLink = Number(argv[++i]);
		else if (arg === '--json') flags.add('json');
		else if (arg === '--help' || arg === '-h') flags.add('help');
	}
	return { flags, opts };
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

function cropColorDistance(a, b) {
	const dL = a.l - b.l;
	const dS = a.s - b.s;
	const hueWeight = Math.min(a.s, b.s) > CHROMA_HUE_MIN_S ? 1 : 0;
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

function identityColorFullPenalty(a, b, basePenalty) {
	if (a && b && isDarkNeutralPair(a, b)) {
		return Math.max(basePenalty, COLOR_DISTANCE_FULL_PENALTY_DARK_NEUTRAL);
	}
	return basePenalty;
}

function identityScore(cosine, colorDistance, fullPenalty) {
	if (colorDistance == null || !Number.isFinite(colorDistance)) return cosine;
	const penalty = Number.isFinite(fullPenalty) && fullPenalty > 0 ? fullPenalty : COLOR_DISTANCE_FULL_PENALTY;
	const agree = Math.max(0, 1 - colorDistance / penalty);
	return cosine * (0.25 + 0.75 * agree);
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

function resolveSlot(category) {
	const key = category?.trim().toLowerCase();
	return key ? SLOT_BY_CATEGORY[key] : undefined;
}

function normalizeSubcategory(value) {
	const key = value?.trim().toLowerCase();
	return key || null;
}

function subcategoryCompatible(probeSub, neighborSub, slot) {
	if (!slot || !SUBCATEGORY_STRICT_SLOTS.has(slot)) return true;
	const probe = normalizeSubcategory(probeSub);
	const neighbor = normalizeSubcategory(neighborSub);
	if (!probe || !neighbor) return true;
	return probe === neighbor;
}

function boxIou(a, b) {
	if (!a || !b) return 0;
	const ax2 = a.x + a.width;
	const ay2 = a.y + a.height;
	const bx2 = b.x + b.width;
	const by2 = b.y + b.height;
	const ix1 = Math.max(a.x, b.x);
	const iy1 = Math.max(a.y, b.y);
	const ix2 = Math.min(ax2, bx2);
	const iy2 = Math.min(ay2, by2);
	const iw = Math.max(0, ix2 - ix1);
	const ih = Math.max(0, iy2 - iy1);
	const inter = iw * ih;
	const union = a.width * a.height + b.width * b.height - inter;
	return union > 0 ? inter / union : 0;
}

async function latestProbeSmoke() {
	const names = await readdir(SMOKE_DIR);
	const candidates = [];
	for (const name of names) {
		if (!name.startsWith('smoke_') || !name.endsWith('.json')) continue;
		const path = join(SMOKE_DIR, name);
		const st = await stat(path);
		let probeCount = 0;
		try {
			const parsed = JSON.parse(await readFile(path, 'utf8'));
			probeCount = Number(parsed.probe_count) || 0;
			if (!probeCount && Array.isArray(parsed.results)) {
				for (const r of parsed.results) {
					for (const it of r.items || []) {
						if (it.identity_probe?.vector?.length) probeCount += 1;
					}
				}
			}
		} catch {
			continue;
		}
		if (probeCount > 0) candidates.push({ path, mtime: st.mtimeMs, probeCount });
	}
	candidates.sort((a, b) => b.mtime - a.mtime);
	return candidates[0]?.path ?? null;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'));
}

function garmentIdForItem(labels, manifest, file, itemIndex, item, { allowIou = false } = {}) {
	const fromLabel = labels?.photos?.[file]?.items?.[String(itemIndex)]?.garment_id?.trim();
	if (fromLabel) return fromLabel;
	if (!allowIou) return null;
	const photo = manifest?.photos?.[file];
	const box = item.bounding_box;
	if (!photo?.garments?.length || !box) return null;
	let best = null;
	let bestIou = 0.35;
	for (const g of photo.garments) {
		if (g.missing || !g.box) continue;
		const iou = boxIou(box, g.box);
		if (iou > bestIou) {
			bestIou = iou;
			best = g.id;
		}
	}
	return best;
}

function humanVerdict(labels, file, itemIndex) {
	return labels?.photos?.[file]?.items?.[String(itemIndex)] ?? null;
}

/**
 * Replay one (penalty, askFloor, autoLinkFloor) configuration.
 * Closet accumulates ground-truth garments as each photo's items are scored then registered.
 */
function replayCorpus({ smoke, labels, manifest, penalty, askFloor, autoLinkFloor, allowIou = false }) {
	/** @type {Map<string, Array<{vector:number[], color:any, category:string, subcategory:string, slot:string, file:string, index:number}>>} */
	const closet = new Map();
	const rows = [];

	let rewearTotal = 0;
	let rewearHit = 0;
	let rewearAuto = 0;
	let falseAsk = 0;
	let falseMerge = 0;
	let scored = 0;
	let skippedNoProbe = 0;
	let skippedNoGarment = 0;
	let photosWithFalseAsk = new Set();

	for (const result of smoke.results || []) {
		if (!result.ok) continue;
		const file = result.file;
		const items = result.items || [];

		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			const probe = item.identity_probe;
			const garmentId = garmentIdForItem(labels, manifest, file, index, item, { allowIou });
			const label = humanVerdict(labels, file, index);

			if (!probe?.vector?.length) {
				skippedNoProbe += 1;
				continue;
			}
			if (!garmentId) {
				skippedNoGarment += 1;
				continue;
			}

			const slot = resolveSlot(item.category);
			const prior = closet.get(garmentId);
			const isRewear = Boolean(prior?.length);

			let best = null;
			for (const [candId, protos] of closet.entries()) {
				for (const proto of protos) {
					if (slot && proto.slot && slot !== proto.slot) continue;
					if (!subcategoryCompatible(item.subcategory, proto.subcategory, slot)) continue;
					const cos = cosineSimilarity(probe.vector, proto.vector);
					if (cos == null) continue;
					const colorD =
						probe.crop_color && proto.color ? cropColorDistance(probe.crop_color, proto.color) : null;
					const fullPen = identityColorFullPenalty(probe.crop_color, proto.color, penalty);
					const score = identityScore(cos, colorD, fullPen);
					if (!best || score > best.score) {
						best = {
							garment_id: candId,
							score,
							cosine: cos,
							color_distance: colorD,
							from_file: proto.file,
							from_index: proto.index,
						};
					}
				}
			}

			let action = 'create';
			let reason = best ? 'below_threshold' : 'no_neighbor';
			if (best && best.score >= askFloor) {
				if (autoLinkFloor != null && best.score >= autoLinkFloor) {
					action = 'auto_link';
					reason = 'auto_link';
				} else {
					action = 'ask';
					reason = 'ask';
				}
			}

			scored += 1;
			const correctNeighbor = best?.garment_id === garmentId;

			if (isRewear) {
				rewearTotal += 1;
				const hit = (action === 'ask' || action === 'auto_link') && correctNeighbor;
				if (hit) {
					rewearHit += 1;
					if (action === 'auto_link') rewearAuto += 1;
				}
			} else {
				// New garment: ask/auto_link against anything is a false ask / merge
				if (action === 'ask') {
					falseAsk += 1;
					photosWithFalseAsk.add(file);
				}
				if (action === 'auto_link') {
					falseMerge += 1;
				}
			}

			// Wrong-garment auto-link on a rewear is also a false merge
			if (isRewear && action === 'auto_link' && !correctNeighbor) {
				falseMerge += 1;
			}
			// Wrong-garment ask on a rewear: counts as miss (not in rewearHit) and a false ask
			if (isRewear && action === 'ask' && !correctNeighbor) {
				falseAsk += 1;
				photosWithFalseAsk.add(file);
			}

			rows.push({
				file,
				index,
				label: item.label,
				category: item.category,
				subcategory: item.subcategory,
				garment_id: garmentId,
				human_verdict: label?.human_verdict ?? null,
				expected_action: label?.expected_action ?? null,
				is_rewear: isRewear,
				action,
				reason,
				score: best?.score ?? null,
				cosine: best?.cosine ?? null,
				color_distance: best?.color_distance ?? null,
				candidate_garment_id: best?.garment_id ?? null,
				correct_neighbor: best ? correctNeighbor : null,
				system_status: item.identity_status ?? null,
				system_score: item.identity_score ?? null,
			});

			// Register this wear on the ground-truth garment (closet grows like a labeled history).
			const list = closet.get(garmentId) || [];
			list.push({
				vector: probe.vector,
				color: probe.crop_color ?? null,
				category: item.category,
				subcategory: item.subcategory,
				slot: slot || 'unknown',
				file,
				index,
			});
			closet.set(garmentId, list);
		}
	}

	const photoCount = (smoke.results || []).filter((r) => r.ok).length || 1;
	return {
		config: { penalty, askFloor, autoLinkFloor },
		scored,
		skipped_no_probe: skippedNoProbe,
		skipped_no_garment: skippedNoGarment,
		rewear_total: rewearTotal,
		rewear_hit: rewearHit,
		rewear_recall: rewearTotal ? rewearHit / rewearTotal : null,
		rewear_auto_link: rewearAuto,
		rewear_auto_share: rewearHit ? rewearAuto / rewearHit : null,
		false_ask: falseAsk,
		false_ask_per_photo: falseAsk / photoCount,
		false_merge: falseMerge,
		photos: photoCount,
		rows,
	};
}

function printReport(report, { verboseRows = true } = {}) {
	const pct = (x) => (x == null || Number.isNaN(x) ? '—' : `${(100 * x).toFixed(1)}%`);
	const { config } = report;
	console.log('\nIdentity replay');
	console.log(
		`  ask≥${config.askFloor}  penalty=${config.penalty}  auto-link=${config.autoLinkFloor ?? 'off'}`
	);
	console.log(
		`  scored ${report.scored}  (skip probe=${report.skipped_no_probe}, no garment_id=${report.skipped_no_garment})`
	);
	console.log(
		`  rewear recall  ${report.rewear_hit}/${report.rewear_total}  ${pct(report.rewear_recall)}` +
			(config.autoLinkFloor != null
				? `  (auto-linked ${report.rewear_auto_link}, share ${pct(report.rewear_auto_share)})`
				: '')
	);
	console.log(
		`  false asks     ${report.false_ask}  (~${report.false_ask_per_photo.toFixed(2)}/photo)`
	);
	console.log(`  false merges   ${report.false_merge}`);

	if (!verboseRows) return;

	const misses = report.rows.filter((r) => r.is_rewear && !(r.action !== 'create' && r.correct_neighbor));
	const falses = report.rows.filter(
		(r) =>
			(!r.is_rewear && (r.action === 'ask' || r.action === 'auto_link')) ||
			(r.is_rewear && r.action !== 'create' && r.correct_neighbor === false)
	);

	if (misses.length) {
		console.log('\n  Missed rewears:');
		for (const r of misses) {
			console.log(
				`    ${r.file}[${r.index}] ${r.garment_id} → ${r.action}` +
					(r.score != null
						? ` score=${r.score.toFixed(3)} cos=${r.cosine?.toFixed(3)} cd=${r.color_distance?.toFixed(3)} cand=${r.candidate_garment_id}`
						: ' (no neighbor)')
			);
		}
	}
	if (falses.length) {
		console.log('\n  False ask / merge:');
		for (const r of falses) {
			console.log(
				`    ${r.file}[${r.index}] ${r.label} (${r.garment_id}) → ${r.action} ` +
					`score=${r.score?.toFixed(3)} cand=${r.candidate_garment_id}`
			);
		}
	}
}

function printSweep(table) {
	console.log('\nSweep (ask floor × penalty × auto-link)');
	console.log(
		'ask   pen   auto   recall   falseAsk/ph  falseMerge  rewear_hit/total'
	);
	for (const row of table) {
		const recall = row.rewear_recall == null ? '   —  ' : `${(100 * row.rewear_recall).toFixed(1).padStart(5)}%`;
		console.log(
			`${String(row.askFloor).padEnd(5)} ${String(row.penalty).padEnd(5)} ${String(row.autoLinkFloor ?? 'off').padEnd(6)} ` +
				`${recall}  ${row.false_ask_per_photo.toFixed(2).padStart(10)}  ${String(row.false_merge).padStart(10)}  ` +
				`${row.rewear_hit}/${row.rewear_total}`
		);
	}
}

async function main() {
	const { flags, opts } = parseArgs(process.argv.slice(2));
	if (flags.has('help')) {
		console.log(`Usage: npm run identity:replay -- [options]
  --smoke <path>     Smoke JSON with identity_probe (default: latest with probes)
  --ask-floor <n>    Ask threshold (default ${IDENTITY_MATCH_MIN})
  --penalty <n>      COLOR_DISTANCE_FULL_PENALTY (default ${COLOR_DISTANCE_FULL_PENALTY})
  --auto-link <n>    Optional silent-merge floor (off by default)
  --sweep            Grid over ask floors, penalties, auto-link candidates
  --json             Print full JSON report`);
		return;
	}

	const smokePath = opts.smoke
		? resolve(opts.smoke)
		: await latestProbeSmoke();
	if (!smokePath || !existsSync(smokePath)) {
		throw new Error('No smoke with probes found. Run npm run extract:smoke first.');
	}
	if (!existsSync(LABELS_PATH)) {
		throw new Error(`Missing ${LABELS_PATH}`);
	}

	const smoke = await readJson(smokePath);
	const labels = await readJson(LABELS_PATH);
	const manifest = existsSync(MANIFEST_PATH) ? await readJson(MANIFEST_PATH) : { garments: [], photos: {} };

	console.log(`Smoke:    ${basename(smokePath)} (probes≈${smoke.probe_count ?? '?'})`);
	console.log(`Labels:   ${LABELS_PATH}`);
	console.log(`Manifest: ${MANIFEST_PATH}${existsSync(MANIFEST_PATH) ? '' : ' (missing)'}`);

	if (flags.has('sweep')) {
		const askFloors = [0.45, 0.5, 0.55, 0.6];
		const penalties = [0.12, 0.2, 0.3, 0.4];
		const autoLinks = [null, 0.85, 0.9, 0.95];
		const table = [];
		for (const askFloor of askFloors) {
			for (const penalty of penalties) {
				for (const autoLinkFloor of autoLinks) {
					const report = replayCorpus({
						smoke,
						labels,
						manifest,
						penalty,
						askFloor,
						autoLinkFloor,
					});
					table.push({
						askFloor,
						penalty,
						autoLinkFloor,
						rewear_recall: report.rewear_recall,
						false_ask_per_photo: report.false_ask_per_photo,
						false_merge: report.false_merge,
						rewear_hit: report.rewear_hit,
						rewear_total: report.rewear_total,
					});
				}
			}
		}
		// Prefer high recall, then low false merge, then low false ask.
		table.sort((a, b) => {
			const ar = a.rewear_recall ?? -1;
			const br = b.rewear_recall ?? -1;
			if (br !== ar) return br - ar;
			if (a.false_merge !== b.false_merge) return a.false_merge - b.false_merge;
			return a.false_ask_per_photo - b.false_ask_per_photo;
		});
		printSweep(table.slice(0, 24));
		console.log('\n(top 24 by recall, then false-merge, then false-ask/photo)');

		const baseline = replayCorpus({
			smoke,
			labels,
			manifest,
			penalty: COLOR_DISTANCE_FULL_PENALTY,
			askFloor: IDENTITY_MATCH_MIN,
			autoLinkFloor: null,
		});
		printReport(baseline, { verboseRows: true });
		if (flags.has('json')) {
			console.log(JSON.stringify({ sweep: table, baseline }, null, 2));
		}
		return;
	}

	const report = replayCorpus({
		smoke,
		labels,
		manifest,
		penalty: Number.isFinite(opts.penalty) ? opts.penalty : COLOR_DISTANCE_FULL_PENALTY,
		askFloor: Number.isFinite(opts.askFloor) ? opts.askFloor : IDENTITY_MATCH_MIN,
		autoLinkFloor: Number.isFinite(opts.autoLink) ? opts.autoLink : null,
	});
	printReport(report);
	if (flags.has('json')) {
		console.log(JSON.stringify(report, null, 2));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
