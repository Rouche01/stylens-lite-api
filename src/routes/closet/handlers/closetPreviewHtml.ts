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
  .stage { position: relative; display: inline-block; max-width: 100%; vertical-align: top; }
  .stage img { display: block; max-width: min(100vw, 900px); height: auto; }
  .box { position: absolute; border: 2px solid rgba(255,255,255,.7); box-sizing: border-box; pointer-events: none; }
  .box-hi { border-color: #f5c518; border-width: 3px; z-index: 2; }
  .box span { position: absolute; left: 0; bottom: 100%; margin: 0 0 4px; background: rgba(0,0,0,.75); color: #fff; font-size: 11px; line-height: 1.2; padding: 2px 6px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .box-hi span { background: #f5c518; color: #111; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(page.title)}</h1>
  <p>${escapeHtml(page.subtitle)}</p>
  <button type="button" id="toggle-all">${escapeHtml(toggleLabel)}</button>
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
</script>
</body>
</html>`;
}
