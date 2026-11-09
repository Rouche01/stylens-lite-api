export type PreviewBox = {
	closet_item_id: string;
	label: string;
	color: string;
	bounding_box: { x: number; y: number; width: number; height: number };
	highlighted: boolean;
};

export type ClosetPreviewPage = {
	title: string;
	subtitle: string;
	imageUrl: string;
	boxes: PreviewBox[];
	showAll: boolean;
};

/** Admin compare: closet tile (padded crop) vs item view (native-aspect unpadded crop, seed dimmed). */
export type ClosetItemFocusPage = {
	title: string;
	subtitle: string;
	itemId: string;
	label: string;
	cropUrl: string;
	isolateUrl: string;
	originalUrl: string;
	/** Native-aspect item crop (`cutout=0&pad=0`). Empty falls back to originalUrl. */
	itemCropUrl: string;
	paddedBox: { x: number; y: number; width: number; height: number };
	/** Unpadded detector box in the item-crop's local percent space. */
	seedBox: { x: number; y: number; width: number; height: number };
	aspectRatio: number;
	aspectFallback: boolean;
	blurHash: string;
	photoWidth?: number | null;
	photoHeight?: number | null;
};

export const CLOSET_SCREEN_FALLBACK_ASPECT = 4 / 5;

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function boxStyle(box: PreviewBox['bounding_box']): string {
	return [
		`left:${box.x}%`,
		`top:${box.y}%`,
		`width:${box.width}%`,
		`height:${box.height}%`,
	].join(';');
}

export function renderClosetPreviewHtml(page: ClosetPreviewPage): string {
	const boxesHtml = page.boxes
		.map((box) => {
			const cls = box.highlighted ? 'box box-hi' : 'box';
			const label = escapeHtml(`${box.label} · ${box.color}`);
			return `<div class="${cls}" style="${boxStyle(box.bounding_box)}"><span>${label}</span></div>`;
		})
		.join('');

	const toggleLabel = page.showAll ? 'This item only' : 'All boxes on this outfit';
	const toggleAll = page.showAll ? '0' : '1';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(page.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
  header { padding: 12px 16px; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  p { margin: 0; color: #aaa; font-size: 13px; }
  button { background: #2a2a2a; color: #eee; border: 1px solid #444; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  .stage { position: relative; display: inline-block; max-width: 100%; vertical-align: top; overflow: hidden; }
  .stage img { display: block; max-width: min(100vw, 900px); height: auto; }
  .box { position: absolute; border: 2px solid rgba(255,255,255,.7); box-sizing: border-box; pointer-events: none; }
  .box-hi { border-color: #f5c518; border-width: 3px; z-index: 2; box-shadow: 0 0 0 9999px rgba(0,0,0,.5); }
  .box span { position: absolute; left: 0; bottom: 100%; margin: 0 0 4px; background: rgba(0,0,0,.75); color: #fff; font-size: 11px; line-height: 1.2; padding: 2px 6px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .box-hi span { background: #f5c518; color: #111; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(page.title)}</h1>
  <p>${escapeHtml(page.subtitle)}</p>
  <button type="button" id="toggle-all">${escapeHtml(toggleLabel)}</button>
  <button type="button" id="to-closet">Tile vs item</button>
</header>
<div class="stage">
  <img src="${escapeHtml(page.imageUrl)}" alt="Outfit"/>
  ${boxesHtml}
</div>
<script>
  document.getElementById('toggle-all')?.addEventListener('click', function () {
    var u = new URL(location.href);
    u.searchParams.set('all', ${JSON.stringify(toggleAll)});
    location.href = u.toString();
  });
  document.getElementById('to-closet')?.addEventListener('click', function () {
    var u = new URL(location.href);
    u.searchParams.set('layout', 'closet');
    location.href = u.toString();
  });
</script>
</body>
</html>`;
}

export function renderClosetScreenHtml(page: ClosetItemFocusPage): string {
	const ratio = page.aspectRatio > 0 ? page.aspectRatio : CLOSET_SCREEN_FALLBACK_ASPECT;
	const blur = page.blurHash ? escapeHtml(page.blurHash) : '';
	const crop = page.cropUrl
		? `<img class="hero-img" src="${escapeHtml(page.cropUrl)}" alt="${escapeHtml(page.label)}"/>`
		: `<div class="ph">no crop</div>`;
	const canvas = blur
		? `<canvas data-blurhash="${blur}" data-ratio="${ratio}"></canvas>`
		: `<div class="wash"></div>`;
	const itemSrc = page.itemCropUrl || page.originalUrl;
	const itemPhoto = itemSrc
		? `<img class="item-photo" alt="${escapeHtml(page.label)}" src="${escapeHtml(itemSrc)}"/>`
		: `<div class="ph">no photo</div>`;
	const itemSpot = `<div class="seed-spot" style="${boxStyle(page.seedBox)}"></div>`;
	const meta = [
		`id ${page.itemId}`,
		page.aspectFallback ? 'aspect 4/5 fallback' : `aspect ${page.aspectRatio}`,
		page.photoWidth && page.photoHeight ? `${page.photoWidth}×${page.photoHeight}` : 'photo size missing',
		page.blurHash ? 'blurhash yes' : 'blurhash missing',
		page.cropUrl ? 'crop yes' : 'crop missing',
	].join(' · ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(page.title)} — tile vs item</title>
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=clash-display@600&amp;f[]=satoshi@500,600&amp;display=swap"/>
<style>
  :root {
    --green: #3d4a3d;
    --lime: #b8e994;
    --mist: #e8f5e8;
    --radius: 18px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Satoshi, ui-sans-serif, system-ui, sans-serif; background: #dfe9dc; color: #2c352c; }
  header { padding: 12px 16px; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-family: "Clash Display", sans-serif; font-size: 18px; margin: 0; font-weight: 600; color: var(--green); }
  p { margin: 0; color: #5a675a; font-size: 13px; }
  button { background: var(--green); color: var(--lime); border: 0; border-radius: 999px; padding: 8px 12px; cursor: pointer; font: 600 13px Satoshi, sans-serif; }
  .meta { padding: 0 16px 12px; font-size: 12px; color: #7a8a7a; }
  .page { display: grid; gap: 24px; padding: 8px 16px 40px; max-width: 1100px; }
  @media (min-width: 860px) { .page { grid-template-columns: minmax(220px, 0.85fr) minmax(320px, 1.2fr); align-items: start; } }
  .card h2 { font-family: "Clash Display", sans-serif; font-size: 16px; margin: 0 0 4px; color: var(--green); }
  .kicker { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #6d7d6d; margin: 0 0 8px; }
  .hero {
    position: relative; border-radius: var(--radius); overflow: hidden; background: #d5e4d4;
  }
  .hero.tile { max-width: 240px; }
  .hero.item { max-width: 640px; }
  .item-stage { position: relative; overflow: hidden; }
  .item-photo { display: block; width: 100%; height: auto; }
  .hero canvas, .hero .wash { position: absolute; inset: 0; width: 100%; height: 100%; }
  .hero-img { position: relative; display: block; width: 100%; height: auto; }
  .hero .ph { position: relative; display: flex; align-items: center; justify-content: center; color: #7a8a7a; min-height: 160px; width: 100%; }
  .hero figcaption {
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; padding: 28px 12px 10px;
    background: linear-gradient(transparent, color-mix(in srgb, var(--green) 72%, black));
    color: #fff; font-size: 13px; font-weight: 600;
  }
  .seed-spot {
    position: absolute; z-index: 1; box-sizing: border-box; pointer-events: none;
    border: 1px solid rgba(255,255,255,.45);
    box-shadow: 0 0 0 9999px rgba(0,0,0,.46);
  }
  .note { font-size: 12px; color: #7a8a7a; margin: 8px 0 12px; line-height: 1.4; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(page.title)}</h1>
  <p>${escapeHtml(page.subtitle)}</p>
  <button type="button" id="to-layout">Photo boxes</button>
</header>
<p class="meta">${escapeHtml(meta)}</p>
<div class="page">
  <section class="card">
    <p class="kicker">A · Closet tile</p>
    <h2>Padded crop</h2>
    <p class="note">Browse tile: category-padded photo crop at full brightness. No dim overlay.</p>
    <figure class="hero tile" style="--ratio:${ratio}">
      ${canvas}
      ${crop}
      <figcaption>${escapeHtml(page.label)}</figcaption>
    </figure>
  </section>
  <section class="card">
    <p class="kicker">B · Item view</p>
    <h2>Outfit, person in focus</h2>
    <p class="note">Native-aspect trim + scale-down centered on the person wearing this item. Extra wall and floor are clipped, never stretched. Bright region is the unpadded garment box.</p>
    <figure class="hero item">
      <div class="item-stage">
        ${itemPhoto}
        ${itemSpot}
      </div>
      <figcaption>${escapeHtml(page.label)}</figcaption>
    </figure>
  </section>
</div>
<script>
  document.getElementById('to-layout')?.addEventListener('click', function () {
    var u = new URL(location.href);
    u.searchParams.delete('layout');
    location.href = u.toString();
  });
  document.querySelectorAll('canvas[data-blurhash]').forEach(function (canvas) {
    var hash = canvas.getAttribute('data-blurhash');
    if (!hash) return;
    import('https://cdn.jsdelivr.net/npm/blurhash@2.0.5/+esm').then(function (mod) {
      var w = 32;
      var r = Number(canvas.getAttribute('data-ratio')) || ${CLOSET_SCREEN_FALLBACK_ASPECT};
      var h = Math.max(3, Math.round(w / r));
      var pixels = mod.decode(hash, w, h);
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var img = ctx.createImageData(w, h);
      img.data.set(pixels);
      ctx.putImageData(img, 0, 0);
    }).catch(function () {});
  });
</script>
</body>
</html>`;
}
