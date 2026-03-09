import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
	resolve: {
		alias: {
			'db': new URL('./src/db', import.meta.url).pathname,
			'utils': new URL('./src/utils', import.meta.url).pathname,
			'types': new URL('./src/types', import.meta.url).pathname,
			'middlewares': new URL('./src/middlewares', import.meta.url).pathname,
			'services': new URL('./src/services', import.meta.url).pathname,
			'routes': new URL('./src/routes', import.meta.url).pathname
		}
	}
});
