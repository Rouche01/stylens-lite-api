import { EmailTemplateKey, RenderedEmailTemplate } from '../types';
import { activationD0 } from './activation_d0';
import { EmailTemplateRenderer, TemplateContext } from './types';

export type { TemplateContext } from './types';

const templates: Record<EmailTemplateKey, EmailTemplateRenderer> = {
	activation_d0: activationD0,
};

export function renderEmailTemplate(
	templateKey: EmailTemplateKey,
	ctx: TemplateContext = {}
): RenderedEmailTemplate {
	const render = templates[templateKey];
	if (!render) {
		throw new Error(`Unknown email template: ${templateKey}`);
	}
	return render(ctx);
}
