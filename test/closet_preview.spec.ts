import { describe, it, expect } from 'vitest';
import {
	escapeHtml,
	renderClosetFaceCompareHtml,
	renderClosetPreviewHtml,
	renderClosetScreenHtml,
} from '../src/routes/closet/handlers/closetPreviewHtml';

describe('escapeHtml', () => {
	it('escapes markup in labels', () => {
		expect(escapeHtml(`<img src="x" onerror="alert('xss')">`)).toBe(
			'&lt;img src=&quot;x&quot; onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;'
		);
	});
});

describe('renderClosetPreviewHtml', () => {
	it('draws percent boxes and does not embed an admin key', () => {
		const html = renderClosetPreviewHtml({
			title: 'Olive jacket',
			subtitle: 'olive jacket',
			imageUrl: 'https://example.r2.cloudflarestorage.com/photo.jpg?X-Amz-Signature=secret',
			showAll: false,
			boxes: [
				{
					closet_item_id: 'a',
					label: 'Olive jacket',
					color: 'olive',
					bounding_box: { x: 10, y: 20, width: 30, height: 40 },
					highlighted: true,
				},
			],
		});

		expect(html).toContain('left:10%');
		expect(html).toContain('top:20%');
		expect(html).toContain('width:30%');
		expect(html).toContain('height:40%');
		expect(html).toContain('box-hi');
		expect(html).not.toContain('admin_key');
		expect(html).toContain('Olive jacket · olive');
	});

	it('escapes labels inside the overlay', () => {
		const html = renderClosetPreviewHtml({
			title: 'Item',
			subtitle: 'n',
			imageUrl: 'https://example.com/p.jpg',
			showAll: true,
			boxes: [
				{
					closet_item_id: 'a',
					label: '<script>alert(1)</script>',
					color: 'red',
					bounding_box: { x: 0, y: 0, width: 10, height: 10 },
					highlighted: false,
				},
			],
		});
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});
});

describe('renderClosetScreenHtml', () => {
	it('shows a padded tile and a native-aspect item crop with the seed dimmed', () => {
		const html = renderClosetScreenHtml({
			title: 'Olive jacket',
			subtitle: 'olive jacket',
			itemId: 'a',
			label: 'Olive jacket',
			cropUrl: 'http://127.0.0.1:8787/assets/isolate?key=users%2Fu1%2Fphoto.jpg&x=10&y=20&w=30&h=40&width=960&cutout=0',
			isolateUrl: 'http://127.0.0.1:8787/assets/isolate?key=users%2Fu1%2Fphoto.jpg&x=10&y=20&w=30&h=40&width=480',
			originalUrl: 'https://example.r2.cloudflarestorage.com/photo.jpg?X-Amz-Signature=secret',
			itemCropUrl: 'http://127.0.0.1:8787/assets/isolate?key=users%2Fu1%2Fphoto.jpg&x=0&y=8&w=65&h=65&width=960&cutout=0&pad=0',
			paddedBox: { x: 8, y: 16, width: 34, height: 48 },
			seedBox: { x: 20, y: 40, width: 60, height: 80 },
			aspectRatio: 0.72,
			aspectFallback: false,
			blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
			photoWidth: 1350,
			photoHeight: 1800,
		});

		expect(html).toContain('cutout=0');
		expect(html).toContain('width=960');
		expect(html).toContain('hero-img');
		expect(html).toContain('item-photo');
		expect(html).toContain('item-stage');
		expect(html).toContain('height: auto');
		expect(html).not.toContain('object-fit: cover');
		expect(html).not.toContain('aspect-ratio: var(--item-ratio)');
		expect(html).toContain('data-blurhash="LEHV6nWB2yk8pyo0adR*.7kCMdnj"');
		expect(html).toContain('aspect 0.72');
		expect(html).toContain('A · Closet tile');
		expect(html).toContain('B · Item view');
		expect(html).toContain('Outfit, person in focus');
		expect(html).toContain('1350×1800');
		expect(html).not.toContain('Same crop, pad dimmed');
		expect(html).not.toContain('Highlight SAM');
		expect(html).not.toContain('admin_key');
		expect(html).not.toContain('Your Closet');

		const tileHtml = html.slice(html.indexOf('A · Closet tile'), html.indexOf('B · Item view'));
		const itemHtml = html.slice(html.indexOf('B · Item view'));
		expect(tileHtml).not.toContain('class="seed-spot"');
		expect(tileHtml).not.toContain('item-photo');
		expect(tileHtml).not.toContain('pad=0');
		expect(itemHtml).toContain('class="seed-spot"');
		expect(itemHtml).toContain('left:20%');
		expect(itemHtml).toContain('top:40%');
		expect(itemHtml).toContain('pad=0');
		expect(itemHtml).toContain('cutout=0');
		expect(itemHtml).not.toContain('X-Amz-Signature');
	});

	it('escapes labels and notes the 4/5 fallback', () => {
		const html = renderClosetScreenHtml({
			title: 'Item',
			subtitle: 'n',
			itemId: 'a',
			label: '<script>alert(1)</script>',
			cropUrl: '',
			isolateUrl: '',
			originalUrl: 'https://example.com/p.jpg',
			itemCropUrl: '',
			paddedBox: { x: 0, y: 0, width: 10, height: 10 },
			seedBox: { x: 2, y: 2, width: 6, height: 6 },
			aspectRatio: 0.8,
			aspectFallback: true,
			blurHash: '',
		});
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('aspect 4/5 fallback');
		expect(html).toContain('blurhash missing');
	});
});

describe('renderClosetFaceCompareHtml', () => {
	it('shows crop, CF, SAM, and packshot columns without embedding secrets', () => {
		const html = renderClosetFaceCompareHtml({
			title: 'Pink tee',
			subtitle: 'pink t-shirt',
			itemId: 'item-1',
			label: 'Pink tee',
			cropUrl: 'http://127.0.0.1:8787/assets/isolate?key=p.jpg&cutout=0&width=960',
			cfCutoutUrl: 'http://127.0.0.1:8787/assets/isolate?key=p.jpg&width=480',
			samFaceUrl: 'https://example.com/cutouts/scratch/face.png',
			samNote: 'SAM + BiRefNet ok',
			samModel: 'fal-ai/sam-3/image+birefnet',
			packshotUrl: 'https://example.com/cutouts/scratch/pack.png',
			packshotNote: 'Nano Banana flat-lay ok',
			packshotModel: 'fal-ai/nano-banana/edit',
			aspectRatio: 0.8,
		});

		expect(html).toContain('A · Product default');
		expect(html).toContain('B · CF Images');
		expect(html).toContain('C · Tier 1 spike');
		expect(html).toContain('D · Tier 3 spike');
		expect(html).toContain('cutout=0');
		expect(html).toContain('face.png');
		expect(html).toContain('pack.png');
		expect(html).toContain('SAM + BiRefNet ok');
		expect(html).toContain('fal-ai/nano-banana/edit');
		expect(html).toContain('Run packshot');
		expect(html).not.toContain('admin_key');
		expect(html).not.toContain('X-Amz-Signature');
	});

	it('shows SAM failure note when face URL is empty', () => {
		const html = renderClosetFaceCompareHtml({
			title: 'Item',
			subtitle: 'n',
			itemId: 'a',
			label: '<script>x</script>',
			cropUrl: '',
			cfCutoutUrl: '',
			samFaceUrl: '',
			samNote: 'SAM 3 found no matching concept',
			samModel: '',
			packshotUrl: '',
			packshotNote: 'Append &packshot=1',
			packshotModel: '',
			aspectRatio: 0,
		});
		expect(html).toContain('SAM 3 found no matching concept');
		expect(html).toContain('Append &amp;packshot=1');
		expect(html).not.toContain('<script>x</script>');
		expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
	});
});
