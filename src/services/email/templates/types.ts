import { RenderedEmailTemplate } from '../types';

export type TemplateContext = {
	userName?: string;
	unsubscribeUrl?: string;
	deepLinkUrl?: string;
};

export type EmailTemplateRenderer = (ctx: TemplateContext) => RenderedEmailTemplate;
