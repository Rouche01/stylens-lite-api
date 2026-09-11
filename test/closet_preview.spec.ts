import { describe, it, expect } from 'vitest';
import { escapeHtml, renderClosetPreviewHtml } from '../src/routes/closet/handlers/closetPreviewHtml';

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
