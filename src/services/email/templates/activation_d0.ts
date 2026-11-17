import { RenderedEmailTemplate } from '../types';
import { escapeAttr, escapeHtml } from './html';
import { TemplateContext } from './types';

/** Lifecycle: opted-in users who haven't completed a tip yet. */
export function activationD0(ctx: TemplateContext): RenderedEmailTemplate {
	const name = ctx.userName?.trim() || 'there';
	const cta = ctx.deepLinkUrl || 'https://gostylens.app';
	const unsub = ctx.unsubscribeUrl;

	const subject = 'Ready for your first fit check?';
	const textLines = [
		`Hi ${name},`,
		'',
		'Your style tip is one photo away. Open GoStylens, snap your outfit, and get a clear fit check.',
		'',
		`Start here: ${cta}`,
	];
	if (unsub) {
		textLines.push('', `Unsubscribe: ${unsub}`);
	}

	const html = `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; line-height: 1.5; color: #111;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Your style tip is one photo away. Open GoStylens, snap your outfit, and get a clear fit check.</p>
  <p><a href="${escapeAttr(cta)}">Get your first fit check</a></p>
  ${unsub ? `<p style="font-size: 12px; color: #666;"><a href="${escapeAttr(unsub)}">Unsubscribe</a></p>` : ''}
</body>
</html>`.trim();

	return { subject, html, text: textLines.join('\n') };
}
