# StyleLens Lite API

Cloudflare Workers API for StyleLens — style analysis sessions, user management, subscriptions, and related features. Uses D1, R2, and Supabase auth.

## Development

```bash
npm install
npm run dev          # local wrangler dev
npm test             # vitest
npm run db:migrate   # apply D1 migrations
```

Copy `.dev.vars.example` to `.dev.vars` and configure secrets before running locally. See `wrangler.example.jsonc` for Worker bindings and env var structure.

## Documentation

| Topic | Location |
|-------|----------|
| **Subscription limits** (Free trial, monthly quota, enforcement) | [docs/subscription-limits.md](docs/subscription-limits.md) |
| **Email channel** (lifecycle marketing — ESP, consent UX, segments) | [docs/email-channel.md](docs/email-channel.md) |
| Session memory | [docs/session-memory.md](docs/session-memory.md) |
| Blurhash backfill script | [scripts/BACKFILL_BLURHASH.md](scripts/BACKFILL_BLURHASH.md) |

Executable limit scenarios live in `test/effectiveLimits.spec.ts` (`documented free-tier scenarios`).
