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
	dirty: false,
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
			notes: '',
		};
	}
	return photo.items[index];
}

function markDirty(msg = 'Unsaved changes') {
	state.dirty = true;
	els.saveStatus.textContent = msg;
}

async function api(path, opts) {
	const res = await fetch(path, opts);
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

async function init() {
	const [smokeList, labels] = await Promise.all([api('/api/smoke'), api('/api/labels')]);
	state.labels = labels?.photos ? labels : { version: 1, updated_at: null, photos: {} };

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

function systemIdentityHtml(item) {
	const status = item.identity_status;
	if (!status && item.identity_score == null && !item.identity_reason) {
		return `
			<div class="system-identity">
				<p class="system-identity-row muted small">No identity fields on this smoke (legacy Claude-only run).</p>
			</div>
		`;
	}

	const score = formatScore(item.identity_score);
	const statusClass =
		status === 'created' ? 'pill-created' : status === 'ask' ? 'pill-ask' : status === 'failed' ? 'pill-failed' : 'pill-muted';

	const idParts = [
		item.closet_item_id ? `closet ${shortId(item.closet_item_id)}` : null,
		item.candidate_closet_item_id ? `candidate ${shortId(item.candidate_closet_item_id)}` : null,
		item.match_id ? `match ${shortId(item.match_id)}` : null,
	].filter(Boolean);

	return `
		<div class="system-identity">
			<p class="system-identity-row">
				<span class="chip-row-label" style="width:auto;margin:0">System</span>
				<span class="pill ${statusClass}">${escapeHtml(status || '—')}</span>
				${score != null ? `<span class="pill pill-muted">score ${escapeHtml(score)}</span>` : ''}
				${item.identity_reason ? `<span class="pill pill-muted">${escapeHtml(item.identity_reason)}</span>` : ''}
			</p>
			${idParts.length ? `<p class="system-identity-ids mono">${escapeHtml(idParts.join(' · '))}</p>` : ''}
		</div>
	`;
}

function renderItems() {
	const result = currentResult();
	els.itemList.innerHTML = '';
	if (!result) return;

	const key = photoKey(result);
	(result.items || []).forEach((item, index) => {
		const label = itemLabel(key, index);
		const color = COLORS[index % COLORS.length];
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
			${systemIdentityHtml(item)}
			<div class="chips" data-group="extract">
				<span class="chip-row-label">Extract</span>
				<button type="button" class="chip ${label.extract_verdict === 'ok' ? 'active-ok' : ''}" data-field="extract_verdict" data-value="ok">ok</button>
				<button type="button" class="chip ${label.extract_verdict === 'wrong' ? 'active-wrong' : ''}" data-field="extract_verdict" data-value="wrong">wrong</button>
				<button type="button" class="chip ${label.extract_verdict === 'spurious' ? 'active-spurious' : ''}" data-field="extract_verdict" data-value="spurious">spurious</button>
			</div>
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
				<input type="text" data-field="notes" placeholder="Item note" value="${escapeAttr(label.notes || '')}" />
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

		const notesInput = card.querySelector('input[data-field="notes"]');
		notesInput.addEventListener('input', () => {
			itemLabel(key, index).notes = notesInput.value;
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
	els.saveStatus.textContent = 'Saving…';
	const saved = await api('/api/labels', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ photos: state.labels.photos }),
	});
	state.labels = saved;
	state.dirty = false;
	els.saveStatus.textContent = `Saved ${new Date(saved.updated_at).toLocaleTimeString()}`;
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
