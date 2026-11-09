const COLORS = ['#0f6b4c', '#1d4f91', '#9a4d14', '#6b2d6b', '#8f2d2d', '#0b6e6e'];

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.2;

const state = {
	smokeId: null,
	smoke: null,
	photoIndex: 0,
	activeItem: 0,
	labels: { version: 1, updated_at: null, photos: {} },
	manifest: { version: 1, set: '', updated_at: null, garments: [], photos: {} },
	dirty: false,
	saving: false,
	view: { scale: 1, x: 0, y: 0 },
	pan: null,
};

const els = {
	smokeSelect: document.getElementById('smokeSelect'),
	prevBtn: document.getElementById('prevBtn'),
	nextBtn: document.getElementById('nextBtn'),
	saveBtn: document.getElementById('saveBtn'),
	saveStatus: document.getElementById('saveStatus'),
	photoIndex: document.getElementById('photoIndex'),
	photo: document.getElementById('photo'),
	overlay: document.getElementById('overlay'),
	previewEmpty: document.getElementById('previewEmpty'),
	previewFrame: document.getElementById('previewFrame'),
	previewViewport: document.getElementById('previewViewport'),
	zoomIn: document.getElementById('zoomIn'),
	zoomOut: document.getElementById('zoomOut'),
	zoomReset: document.getElementById('zoomReset'),
	zoomLevel: document.getElementById('zoomLevel'),
	photoName: document.getElementById('photoName'),
	panelTitle: document.getElementById('panelTitle'),
	panelMeta: document.getElementById('panelMeta'),
	itemList: document.getElementById('itemList'),
	missingItems: document.getElementById('missingItems'),
	photoNotes: document.getElementById('photoNotes'),
	photoNoteLinks: document.getElementById('photoNoteLinks'),
};

function okResults() {
	return (state.smoke?.results || []).filter((r) => r.ok);
}

function currentResult() {
	return okResults()[state.photoIndex] || null;
}

function photoKey(result = currentResult()) {
	return result?.file || null;
}

function ensurePhotoLabels(key) {
	if (!key) return null;
	if (!state.labels.photos[key]) {
		state.labels.photos[key] = {
			missing_items: '',
			notes: '',
			items: {},
		};
	}
	if (!state.labels.photos[key].items) state.labels.photos[key].items = {};
	return state.labels.photos[key];
}

function itemLabel(key, index) {
	const photo = ensurePhotoLabels(key);
	if (!photo.items[index]) {
		photo.items[index] = {
			extract_verdict: null,
			human_verdict: null,
			expected_action: null,
			garment_id: null,
			notes: '',
		};
	}
	if (!('garment_id' in photo.items[index])) photo.items[index].garment_id = null;
	return photo.items[index];
}

function garmentById(id) {
	if (!id) return null;
	return (state.manifest.garments || []).find((g) => g.id === id) || null;
}

function garmentsSorted() {
	return [...(state.manifest.garments || [])].sort((a, b) =>
		String(a.description || a.id).localeCompare(String(b.description || b.id))
	);
}

function suggestGarmentId(item) {
	const slot =
		item?.category === 'bottom'
			? 'lower'
			: item?.category === 'footwear'
				? 'footwear'
				: item?.category === 'accessory'
					? 'accessory'
					: item?.category === 'full-body'
						? 'full_body'
						: 'upper';
	const tip = String(item?.subcategory || item?.category || 'item')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_|_$/g, '');
	const base = `g_${tip || 'item'}`;
	const existing = new Set((state.manifest.garments || []).map((g) => g.id));
	if (!existing.has(base)) return base;
	for (let i = 2; i < 100; i++) {
		const id = `${base}_${i}`;
		if (!existing.has(id)) return id;
	}
	return `${base}_${Date.now()}`;
}

/** Keep manifest.photos[file] in sync when a label assigns a garment. */
function upsertManifestPhotoGarment(file, garmentId, box, { missing = false } = {}) {
	if (!file || !garmentId) return;
	if (!state.manifest.photos[file]) {
		state.manifest.photos[file] = { notes: '', garments: [] };
	}
	const list = state.manifest.photos[file].garments;
	if (!Array.isArray(list)) state.manifest.photos[file].garments = [];
	const garments = state.manifest.photos[file].garments;
	const idx = garments.findIndex((g) => g.id === garmentId);
	const entry = { id: garmentId };
	if (missing) entry.missing = true;
	else if (box && typeof box === 'object') entry.box = { ...box };
	if (idx >= 0) {
		const prev = garments[idx];
		garments[idx] = {
			...prev,
			...entry,
			box: entry.box || prev.box,
			missing: missing ? true : prev.missing && !entry.box ? true : undefined,
			notes: prev.notes || undefined,
		};
		if (!garments[idx].missing) delete garments[idx].missing;
		if (!garments[idx].notes) delete garments[idx].notes;
	} else {
		garments.push(entry);
	}
}

function assignGarmentToItem(file, itemIndex, garmentId, extractItem) {
	const label = itemLabel(file, itemIndex);
	label.garment_id = garmentId || null;
	if (garmentId) {
		upsertManifestPhotoGarment(file, garmentId, extractItem?.bounding_box);
		if (!label.human_verdict) {
			const first = isFirstSightingInSmoke(garmentId, file, itemIndex);
			label.human_verdict = first ? 'different' : 'same';
			label.expected_action = first ? 'create' : 'ask';
		}
	}
	markDirty();
}

function isFirstSightingInSmoke(garmentId, file, itemIndex) {
	for (const result of okResults()) {
		const key = result.file;
		for (let i = 0; i < (result.items || []).length; i++) {
			if (key === file && i === itemIndex) return true;
			if (itemLabel(key, i).garment_id === garmentId) return false;
		}
	}
	return true;
}

function createGarmentFromItem(extractItem, description) {
	const id = suggestGarmentId(extractItem);
	const name = String(description ?? extractItem?.label ?? id).trim() || id;
	const slot =
		extractItem?.category === 'bottom'
			? 'lower'
			: extractItem?.category === 'footwear'
				? 'footwear'
				: extractItem?.category === 'accessory'
					? 'accessory'
					: extractItem?.category === 'full-body'
						? 'full_body'
						: 'upper';
	state.manifest.garments.push({
		id,
		description: name,
		slot,
		subcategory_hint: extractItem?.subcategory || null,
		status: 'confirmed',
		notes: '',
	});
	return id;
}

function setGarmentDescription(garmentId, description, { requireNonEmpty = false } = {}) {
	const g = garmentById(garmentId);
	if (!g) return;
	const next = String(description ?? '').trim();
	if (requireNonEmpty && !next) return;
	if (next === g.description) return;
	if (!next) return;
	g.description = next;
	if (g.status === 'provisional') g.status = 'confirmed';
	markDirty();
}

/** Ask for a freeform name; Cancel aborts. Prefills extract label so wrong Claude wording is easy to fix. */
function promptGarmentDescription(extractItem) {
	const preset = String(extractItem?.label || '').trim();
	const typed = window.prompt(
		'Name this garment (freeform — correct color/type if the extract label is wrong):',
		preset
	);
	if (typed == null) return null;
	const name = typed.trim();
	return name || preset || null;
}

function markDirty(msg = 'Unsaved changes') {
	state.dirty = true;
	els.saveStatus.textContent = msg;
}

async function api(path, opts) {
	const res = await fetch(path, opts);
	if (!res.ok) {
		const text = await res.text();
		throw new Error(text || `${res.status} ${res.statusText}`);
	}
	const type = res.headers.get('content-type') || '';
	if (!type.includes('application/json')) {
		throw new Error(`Expected JSON from ${path}, got ${type || 'unknown'}`);
	}
	return res.json();
}

function labeledPhotoCount(photos) {
	return photos && typeof photos === 'object' ? Object.keys(photos).length : 0;
}

async function init() {
	const [smokeList, labels, manifest] = await Promise.all([
		api('/api/smoke'),
		api('/api/labels'),
		api('/api/manifest'),
	]);
	state.labels = labels?.photos ? labels : { version: 1, updated_at: null, photos: {} };
	state.manifest = manifest?.garments ? manifest : { version: 1, set: '', updated_at: null, garments: [], photos: {} };

	els.smokeSelect.innerHTML = '';
	if (!smokeList.runs?.length) {
		els.smokeSelect.innerHTML = '<option value="">No smoke runs in tmp/extract_smoke</option>';
		els.panelMeta.textContent = 'Run node scripts/extract-smoke.mjs first.';
		return;
	}

	for (const run of smokeList.runs) {
		const opt = document.createElement('option');
		opt.value = run.id;
		const source = run.source === 'api_extract' ? 'api' : 'legacy';
		const modelOrUser = run.source === 'api_extract' ? shortId(run.user_id) || 'eval-user' : run.model || 'claude';
		opt.textContent = `${source} · ${run.ok_count ?? '?'} photos · ${modelOrUser} · ${run.id}`;
		els.smokeSelect.appendChild(opt);
	}

	els.smokeSelect.addEventListener('change', () => loadSmoke(els.smokeSelect.value));
	els.prevBtn.addEventListener('click', () => stepPhoto(-1));
	els.nextBtn.addEventListener('click', () => stepPhoto(1));
	els.saveBtn.addEventListener('click', saveLabels);
	els.missingItems.addEventListener('input', () => {
		const key = photoKey();
		if (!key) return;
		ensurePhotoLabels(key).missing_items = els.missingItems.value;
		markDirty();
	});
	els.photoNotes.addEventListener('input', () => {
		const key = photoKey();
		if (!key) return;
		ensurePhotoLabels(key).notes = els.photoNotes.value;
		renderPhotoNoteLinks(els.photoNotes.value);
		markDirty();
	});

	window.addEventListener('keydown', onKey);
	window.addEventListener('resize', () => drawOverlay());
	els.photo.addEventListener('load', () => {
		resetView();
		drawOverlay();
		renderItems();
	});
	bindPreviewInteractions();

	await loadSmoke(smokeList.runs[0].id);
}

async function loadSmoke(id) {
	if (!id) return;
	state.smokeId = id;
	state.smoke = await api(`/api/smoke/${encodeURIComponent(id)}`);
	state.photoIndex = 0;
	state.activeItem = 0;
	els.smokeSelect.value = id;
	renderPhoto();
}

function stepPhoto(delta) {
	const n = okResults().length;
	if (!n) return;
	state.photoIndex = (state.photoIndex + delta + n) % n;
	state.activeItem = 0;
	renderPhoto();
}

function clampZoom(scale) {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

function applyView() {
	const { scale, x, y } = state.view;
	els.previewViewport.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
	els.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

function resetView() {
	state.view = { scale: 1, x: 0, y: 0 };
	applyView();
}

function zoomAt(clientX, clientY, nextScale) {
	const scale = clampZoom(nextScale);
	if (scale === state.view.scale) {
		applyView();
		return;
	}
	const rect = els.previewFrame.getBoundingClientRect();
	const mx = clientX - rect.left;
	const my = clientY - rect.top;
	const ratio = scale / state.view.scale;
	state.view.x = mx - (mx - state.view.x) * ratio;
	state.view.y = my - (my - state.view.y) * ratio;
	state.view.scale = scale;
	if (scale === ZOOM_MIN) {
		state.view.x = 0;
		state.view.y = 0;
	}
	applyView();
}

function zoomBy(factor) {
	const rect = els.previewFrame.getBoundingClientRect();
	zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, state.view.scale * factor);
}

function bindPreviewInteractions() {
	els.zoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP));
	els.zoomOut.addEventListener('click', () => zoomBy(1 / ZOOM_STEP));
	els.zoomReset.addEventListener('click', () => resetView());

	els.previewFrame.addEventListener(
		'wheel',
		(ev) => {
			if (!currentResult() || els.photo.hidden) return;
			ev.preventDefault();
			const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
			zoomAt(ev.clientX, ev.clientY, state.view.scale * factor);
		},
		{ passive: false }
	);

	els.previewFrame.addEventListener('dblclick', (ev) => {
		if (!currentResult() || els.photo.hidden) return;
		ev.preventDefault();
		if (state.view.scale > ZOOM_MIN) {
			resetView();
		} else {
			zoomAt(ev.clientX, ev.clientY, 2.5);
		}
	});

	els.previewFrame.addEventListener('pointerdown', (ev) => {
		if (!currentResult() || els.photo.hidden) return;
		if (ev.button !== 0) return;
		state.pan = {
			pointerId: ev.pointerId,
			startX: ev.clientX,
			startY: ev.clientY,
			originX: state.view.x,
			originY: state.view.y,
		};
		els.previewFrame.classList.add('is-panning');
		els.previewFrame.setPointerCapture(ev.pointerId);
	});

	els.previewFrame.addEventListener('pointermove', (ev) => {
		if (!state.pan || state.pan.pointerId !== ev.pointerId) return;
		state.view.x = state.pan.originX + (ev.clientX - state.pan.startX);
		state.view.y = state.pan.originY + (ev.clientY - state.pan.startY);
		applyView();
	});

	const endPan = (ev) => {
		if (!state.pan || state.pan.pointerId !== ev.pointerId) return;
		state.pan = null;
		els.previewFrame.classList.remove('is-panning');
	};
	els.previewFrame.addEventListener('pointerup', endPan);
	els.previewFrame.addEventListener('pointercancel', endPan);
}

function renderPhoto() {
	const result = currentResult();
	const n = okResults().length;
	els.photoIndex.textContent = n ? `${state.photoIndex + 1} / ${n}` : '—';

	if (!result) {
		els.photo.hidden = true;
		els.overlay.hidden = true;
		els.previewEmpty.hidden = false;
		els.previewFrame.classList.add('is-empty');
		els.photoName.textContent = '';
		els.itemList.innerHTML = '';
		resetView();
		return;
	}

	els.previewEmpty.hidden = true;
	els.previewFrame.classList.remove('is-empty');
	els.photo.hidden = false;
	els.overlay.hidden = false;
	els.photoName.textContent = result.file;
	els.panelTitle.textContent = 'Extracted items';
	els.panelMeta.textContent = panelMetaText(result);

	const key = photoKey(result);
	const photoLabels = ensurePhotoLabels(key);
	els.missingItems.value = photoLabels.missing_items || '';
	els.photoNotes.value = photoLabels.notes || '';
	renderPhotoNoteLinks(photoLabels.notes || '');

	const nextSrc = `/photos/${encodeURIComponent(result.file)}`;
	if (els.photo.getAttribute('src') !== nextSrc) {
		resetView();
		els.photo.src = nextSrc;
	} else {
		resetView();
		drawOverlay();
	}
	renderItems();
}

function panelMetaText(result) {
	const source = state.smoke?.source === 'api_extract' ? 'API extract' : 'Legacy Claude smoke';
	const bits = [
		source,
		`${result.item_count} items`,
		result.elapsed_ms != null ? `${result.elapsed_ms}ms` : null,
		result.outfit_id ? `outfit ${shortId(result.outfit_id)}` : null,
		state.smoke?.user_id ? `user ${shortId(state.smoke.user_id)}` : null,
		result.model || state.smoke?.model || null,
	];
	return bits.filter(Boolean).join(' · ');
}

function shortId(value) {
	const s = String(value || '').trim();
	if (!s) return '';
	return s.length <= 10 ? s : `${s.slice(0, 8)}…`;
}

function formatScore(score) {
	if (score == null || Number.isNaN(Number(score))) return null;
	return Number(score).toFixed(3);
}

/** First smoke photo that created / linked each closet item id (for neighbor preview). */
function closetItemPhotoIndex() {
	const map = new Map();
	for (const result of okResults()) {
		for (const item of result.items || []) {
			const id = item.closet_item_id;
			if (!id || map.has(id)) continue;
			map.set(id, {
				file: result.file,
				label: item.label || null,
				status: item.identity_status || null,
			});
		}
	}
	return map;
}

function neighborRef(item, indexByClosetId = closetItemPhotoIndex()) {
	const neighborId = item.candidate_closet_item_id || null;
	if (!neighborId) return null;
	const hit = indexByClosetId.get(neighborId) || null;
	return {
		closetItemId: neighborId,
		file: hit?.file || null,
		label: hit?.label || null,
		href: hit?.file ? `/photos/${encodeURIComponent(hit.file)}` : null,
	};
}

function neighborPreviewHtml(ref) {
	if (!ref) return '';
	const who = ref.label ? `${ref.label} · ${shortId(ref.closetItemId)}` : shortId(ref.closetItemId);
	if (ref.href && ref.file) {
		return `
			<p class="system-identity-neighbor">
				<span class="chip-row-label" style="width:auto;margin:0">Compared to</span>
				<a class="neighbor-link" href="${escapeAttr(ref.href)}" target="_blank" rel="noopener noreferrer" title="Open source photo in a new tab">
					${escapeHtml(ref.file)} ↗
				</a>
				<span class="muted small mono">${escapeHtml(who)}</span>
			</p>
		`;
	}
	return `
		<p class="system-identity-neighbor muted small">
			Compared to closet ${escapeHtml(shortId(ref.closetItemId))} (source photo not in this smoke run)
		</p>
	`;
}

function smokePhotoFiles() {
	return okResults().map((r) => r.file).filter(Boolean);
}

/** Map note tokens like IMG_3009 or IMG_0379.JPG → full fixture filename in this smoke. */
function resolveMentionedPhotos(text) {
	const raw = String(text || '');
	const files = smokePhotoFiles();
	if (!raw || !files.length) return [];

	const byLower = new Map(files.map((f) => [f.toLowerCase(), f]));
	const byStem = new Map();
	for (const file of files) {
		const stem = file.replace(/\.[^.]+$/, '');
		const key = stem.toLowerCase();
		if (!byStem.has(key)) byStem.set(key, file);
	}

	const tokens = [
		...files.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		...[...byStem.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
	].sort((a, b) => b.length - a.length);

	const re = new RegExp(`\\b(?:${tokens.join('|')})\\b`, 'gi');
	const found = [];
	const seen = new Set();
	for (const match of raw.matchAll(re)) {
		const token = match[0];
		const file = byLower.get(token.toLowerCase()) || byStem.get(token.toLowerCase());
		if (!file || seen.has(file)) continue;
		seen.add(file);
		found.push(file);
	}
	return found;
}

function photoPreviewButtonsHtml(files) {
	if (!files.length) return '';
	return `
		<div class="photo-preview-row" role="group" aria-label="Referenced photos">
			${files
				.map(
					(file) => `
				<a class="photo-preview-btn" href="/photos/${encodeURIComponent(file)}" target="_blank" rel="noopener noreferrer">
					Preview ${escapeHtml(file)} ↗
				</a>`
				)
				.join('')}
		</div>
	`;
}

function renderPhotoNoteLinks(text) {
	if (!els.photoNoteLinks) return;
	const files = resolveMentionedPhotos(text);
	els.photoNoteLinks.innerHTML = photoPreviewButtonsHtml(files);
	els.photoNoteLinks.hidden = files.length === 0;
}

function systemIdentityHtml(item, neighbor = neighborRef(item)) {
	const status = item.identity_status;
	if (!status && item.identity_score == null && !item.identity_reason) {
		return `
			<div class="system-identity">
				<p class="system-identity-row muted small">No identity fields on this smoke (legacy Claude-only run).</p>
			</div>
		`;
	}

	const score = formatScore(item.identity_score);
	const cosine = formatScore(item.identity_cosine);
	const colorD = formatScore(item.identity_color_distance);
	const statusClass =
		status === 'created' ? 'pill-created' : status === 'ask' ? 'pill-ask' : status === 'failed' ? 'pill-failed' : 'pill-muted';

	const idParts = [
		item.closet_item_id ? `closet ${shortId(item.closet_item_id)}` : null,
		item.candidate_closet_item_id
			? `${status === 'ask' ? 'candidate' : 'nearest'} ${shortId(item.candidate_closet_item_id)}`
			: null,
		item.match_id ? `match ${shortId(item.match_id)}` : null,
	].filter(Boolean);

	return `
		<div class="system-identity">
			<p class="system-identity-row">
				<span class="chip-row-label" style="width:auto;margin:0">System</span>
				<span class="pill ${statusClass}">${escapeHtml(status || '—')}</span>
				${score != null ? `<span class="pill pill-muted">score ${escapeHtml(score)}</span>` : ''}
				${cosine != null ? `<span class="pill pill-muted" title="Vectorize/probe cosine before color blend">cos ${escapeHtml(cosine)}</span>` : ''}
				${colorD != null ? `<span class="pill pill-muted" title="Crop color distance (full penalty ≥ 0.12)">color ${escapeHtml(colorD)}</span>` : ''}
				${item.identity_reason ? `<span class="pill pill-muted">${escapeHtml(item.identity_reason)}</span>` : ''}
			</p>
			${neighborPreviewHtml(neighbor)}
			${idParts.length ? `<p class="system-identity-ids mono">${escapeHtml(idParts.join(' · '))}</p>` : ''}
		</div>
	`;
}

function renderItems() {
	const result = currentResult();
	els.itemList.innerHTML = '';
	if (!result) return;

	const key = photoKey(result);
	const indexByClosetId = closetItemPhotoIndex();
	(result.items || []).forEach((item, index) => {
		const label = itemLabel(key, index);
		const color = COLORS[index % COLORS.length];
		const neighbor = neighborRef(item, indexByClosetId);
		const mentioned = resolveMentionedPhotos(label.notes || '');
		// Also offer the system neighbor photo when notes don't name it.
		if (neighbor?.file && !mentioned.includes(neighbor.file)) {
			mentioned.push(neighbor.file);
		}
		const card = document.createElement('article');
		card.className = 'item' + (index === state.activeItem ? ' active' : '');
		card.dataset.index = String(index);
		card.innerHTML = `
			<div class="item-top">
				<div class="swatch" style="background:${color}"></div>
				<div>
					<p class="item-title">${escapeHtml(item.label || 'untitled')}</p>
					<p class="item-meta mono">${escapeHtml(item.category)}/${escapeHtml(item.subcategory)} · ${escapeHtml(item.color)} · ${escapeHtml(item.confidence)}</p>
				</div>
			</div>
			${systemIdentityHtml(item, neighbor)}
			<div class="chips" data-group="extract">
				<span class="chip-row-label">Extract</span>
				<button type="button" class="chip ${label.extract_verdict === 'ok' ? 'active-ok' : ''}" data-field="extract_verdict" data-value="ok">ok</button>
				<button type="button" class="chip ${label.extract_verdict === 'wrong' ? 'active-wrong' : ''}" data-field="extract_verdict" data-value="wrong">wrong</button>
				<button type="button" class="chip ${label.extract_verdict === 'spurious' ? 'active-spurious' : ''}" data-field="extract_verdict" data-value="spurious">spurious</button>
			</div>
			<label class="field block garment-field">
				<span class="chip-row-label">Ground truth garment</span>
				<select data-field="garment_id" class="garment-select">
					<option value="">— none —</option>
					<option value="__new__">＋ new garment…</option>
					${
						label.garment_id && !garmentById(label.garment_id)
							? `<option value="${escapeAttr(label.garment_id)}" selected>${escapeHtml(label.garment_id)} (missing from manifest)</option>`
							: ''
					}
					${garmentsSorted()
						.map((g) => {
							const tag = g.status === 'provisional' ? ' (provisional)' : '';
							const selected = label.garment_id === g.id ? ' selected' : '';
							return `<option value="${escapeAttr(g.id)}"${selected}>${escapeHtml(g.description || g.id)}${tag}</option>`;
						})
						.join('')}
				</select>
				${
					label.garment_id
						? `<input type="text" data-field="garment_description" class="garment-description" placeholder="Garment name (freeform)" value="${escapeAttr(garmentById(label.garment_id)?.description || label.garment_id)}" ${garmentById(label.garment_id) ? '' : 'disabled'} />
						<p class="muted small mono garment-id">${escapeHtml(label.garment_id)}${garmentById(label.garment_id) ? ` · ${escapeHtml(garmentById(label.garment_id).slot || '?')}` : ' · not in manifest — re-create or pick another'}</p>`
						: `<p class="muted small">Pick an existing garment or create one — name is freeform, not the extract label.</p>`
				}
			</label>
			<div class="chips" data-group="identity">
				<span class="chip-row-label">Your identity verdict</span>
				<button type="button" class="chip ${label.human_verdict === 'same' ? 'active-same' : ''}" data-field="human_verdict" data-value="same">same</button>
				<button type="button" class="chip ${label.human_verdict === 'different' ? 'active-different' : ''}" data-field="human_verdict" data-value="different">different</button>
				<button type="button" class="chip ${label.human_verdict === 'unclear' ? 'active-unclear' : ''}" data-field="human_verdict" data-value="unclear">unclear</button>
			</div>
			<div class="chips" data-group="action">
				<span class="chip-row-label">Expected action</span>
				<button type="button" class="chip ${label.expected_action === 'create' ? 'active-create' : ''}" data-field="expected_action" data-value="create">create</button>
				<button type="button" class="chip ${label.expected_action === 'ask' ? 'active-ask' : ''}" data-field="expected_action" data-value="ask">ask</button>
				<button type="button" class="chip ${label.expected_action === 'link' ? 'active-link' : ''}" data-field="expected_action" data-value="link">link</button>
			</div>
			<div class="notes">
				<input type="text" data-field="notes" placeholder="Item note — mention IMG_3009 to get preview buttons" value="${escapeAttr(label.notes || '')}" />
				${photoPreviewButtonsHtml(mentioned)}
			</div>
		`;

		card.addEventListener('mouseenter', () => {
			state.activeItem = index;
			highlightItems();
			drawOverlay();
		});
		card.addEventListener('click', (ev) => {
			if (ev.target.closest('button, input')) return;
			state.activeItem = index;
			highlightItems();
			drawOverlay();
		});

		card.querySelectorAll('button.chip').forEach((btn) => {
			btn.addEventListener('click', () => {
				const field = btn.dataset.field;
				const value = btn.dataset.value;
				const current = itemLabel(key, index);
				current[field] = current[field] === value ? null : value;
				markDirty();
				renderItems();
				drawOverlay();
			});
		});

		const garmentSelect = card.querySelector('select[data-field="garment_id"]');
		garmentSelect.addEventListener('change', () => {
			let value = garmentSelect.value;
			if (value === '__new__') {
				const name = promptGarmentDescription(item);
				if (name == null) {
					garmentSelect.value = label.garment_id || '';
					return;
				}
				value = createGarmentFromItem(item, name);
			}
			assignGarmentToItem(key, index, value || null, item);
			renderItems();
			drawOverlay();
			const desc = els.itemList.querySelector(
				`.item[data-index="${index}"] input[data-field="garment_description"]`
			);
			if (desc) {
				desc.focus();
				desc.select();
			}
		});

		const garmentDesc = card.querySelector('input[data-field="garment_description"]');
		if (garmentDesc) {
			garmentDesc.addEventListener('change', () => {
				setGarmentDescription(label.garment_id, garmentDesc.value, { requireNonEmpty: true });
				renderItems();
			});
			garmentDesc.addEventListener('keydown', (ev) => {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					garmentDesc.blur();
				}
			});
		}

		const notesInput = card.querySelector('input[data-field="notes"]');
		notesInput.addEventListener('input', () => {
			itemLabel(key, index).notes = notesInput.value;
			const files = resolveMentionedPhotos(notesInput.value);
			if (neighbor?.file && !files.includes(neighbor.file)) files.push(neighbor.file);
			const existing = card.querySelector('.photo-preview-row');
			const html = photoPreviewButtonsHtml(files);
			if (existing) {
				if (html) existing.outerHTML = html;
				else existing.remove();
			} else if (html) {
				notesInput.insertAdjacentHTML('afterend', html);
			}
			markDirty();
		});

		els.itemList.appendChild(card);
	});
}

function highlightItems() {
	els.itemList.querySelectorAll('.item').forEach((el) => {
		el.classList.toggle('active', Number(el.dataset.index) === state.activeItem);
	});
}

function drawOverlay() {
	const result = currentResult();
	const img = els.photo;
	const canvas = els.overlay;
	if (!result || !img.naturalWidth || img.hidden) return;

	// Layout size (ignores parent zoom transform) so boxes stay aligned while zooming.
	const w = Math.max(1, Math.round(img.clientWidth));
	const h = Math.max(1, Math.round(img.clientHeight));
	canvas.width = w;
	canvas.height = h;

	const ctx = canvas.getContext('2d');
	ctx.clearRect(0, 0, w, h);

	(result.items || []).forEach((item, index) => {
		const box = item.bounding_box;
		if (!box) return;
		const color = COLORS[index % COLORS.length];
		const x = (box.x / 100) * w;
		const y = (box.y / 100) * h;
		const bw = (box.width / 100) * w;
		const bh = (box.height / 100) * h;
		const active = index === state.activeItem;
		ctx.lineWidth = active ? 3 : 1.5;
		ctx.strokeStyle = color;
		ctx.fillStyle = active ? hexAlpha(color, 0.16) : hexAlpha(color, 0.05);
		ctx.fillRect(x, y, bw, bh);
		ctx.strokeRect(x, y, bw, bh);

		ctx.font = `600 12px "IBM Plex Mono", monospace`;
		ctx.fillStyle = color;
		const tag = `${index + 1}`;
		ctx.fillRect(x, Math.max(0, y - 18), 18, 18);
		ctx.fillStyle = '#fff';
		ctx.fillText(tag, x + 5, Math.max(12, y - 5));
	});
}

function hexAlpha(hex, a) {
	const n = hex.replace('#', '');
	const r = parseInt(n.slice(0, 2), 16);
	const g = parseInt(n.slice(2, 4), 16);
	const b = parseInt(n.slice(4, 6), 16);
	return `rgba(${r},${g},${b},${a})`;
}

function escapeHtml(value) {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function escapeAttr(value) {
	return escapeHtml(value).replaceAll("'", '&#39;');
}

async function saveLabels() {
	if (state.saving) {
		els.saveStatus.textContent = 'Save already in progress…';
		return;
	}
	const photos = state.labels?.photos;
	if (!photos || typeof photos !== 'object') {
		els.saveStatus.textContent = 'Save blocked: labels state is missing photos';
		return;
	}
	// Client-side belt-and-suspenders: never POST an empty wipe while editing.
	if (labeledPhotoCount(photos) === 0) {
		els.saveStatus.textContent = 'Save blocked: no photo labels in memory (refusing empty overwrite)';
		return;
	}
	if (!Array.isArray(state.manifest?.garments)) {
		els.saveStatus.textContent = 'Save blocked: manifest.garments missing';
		return;
	}

	state.saving = true;
	els.saveBtn.disabled = true;
	els.saveStatus.textContent = 'Saving…';
	try {
		let labelsBody;
		let manifestBody;
		try {
			labelsBody = JSON.stringify({ photos });
			manifestBody = JSON.stringify(state.manifest);
		} catch (serErr) {
			throw new Error(`Could not serialize save payload: ${serErr.message}`);
		}
		if (!labelsBody || labelsBody === '{}' || labelsBody === 'null') {
			throw new Error('Labels payload serialized empty');
		}

		// Sequential: labels first, then manifest. Never parallel-race the two files.
		const savedLabels = await api('/api/labels', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: labelsBody,
		});
		if (labeledPhotoCount(savedLabels?.photos) === 0) {
			throw new Error('Server returned empty labels after save — not applying to UI');
		}

		let savedManifest = state.manifest;
		try {
			savedManifest = await api('/api/manifest', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: manifestBody,
			});
		} catch (manifestErr) {
			console.error(manifestErr);
			state.labels = savedLabels;
			state.dirty = true;
			els.saveStatus.textContent = `Labels saved; manifest failed: ${manifestErr.message}`;
			return;
		}

		state.labels = savedLabels;
		state.manifest = savedManifest;
		state.dirty = false;
		const when = savedLabels.updated_at || savedManifest.updated_at;
		els.saveStatus.textContent = `Saved ${when ? new Date(when).toLocaleTimeString() : 'ok'} · ${state.manifest.garments?.length || 0} garments`;
	} catch (err) {
		console.error(err);
		els.saveStatus.textContent = `Save failed: ${err.message}`;
	} finally {
		state.saving = false;
		els.saveBtn.disabled = false;
	}
}

function onKey(ev) {
	if (ev.target.matches('input, textarea, select')) return;
	if (ev.key === 'ArrowLeft') {
		ev.preventDefault();
		stepPhoto(-1);
	} else if (ev.key === 'ArrowRight') {
		ev.preventDefault();
		stepPhoto(1);
	} else if (ev.key === 's' || ev.key === 'S') {
		ev.preventDefault();
		saveLabels();
	} else if (ev.key === '+' || ev.key === '=') {
		ev.preventDefault();
		zoomBy(ZOOM_STEP);
	} else if (ev.key === '-' || ev.key === '_') {
		ev.preventDefault();
		zoomBy(1 / ZOOM_STEP);
	} else if (ev.key === '0') {
		ev.preventDefault();
		resetView();
	} else if (ev.key === '1' || ev.key === '2' || ev.key === '3') {
		const map = { 1: 'ok', 2: 'wrong', 3: 'spurious' };
		const result = currentResult();
		if (!result) return;
		const key = photoKey(result);
		const current = itemLabel(key, state.activeItem);
		const value = map[ev.key];
		current.extract_verdict = current.extract_verdict === value ? null : value;
		markDirty();
		renderItems();
	} else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
		const result = currentResult();
		if (!result?.items?.length) return;
		ev.preventDefault();
		const delta = ev.key === 'ArrowUp' ? -1 : 1;
		state.activeItem = (state.activeItem + delta + result.items.length) % result.items.length;
		highlightItems();
		drawOverlay();
	}
}

init().catch((err) => {
	els.panelMeta.textContent = String(err?.message || err);
	console.error(err);
});
