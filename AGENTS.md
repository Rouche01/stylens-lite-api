# AGENTS.md — GoStylens Lite API

Guidance for AI coding agents working in this repository. Keep changes focused; prefer matching existing patterns over inventing new ones.

## What this is

Cloudflare Workers API for **GoStylens**: style-analysis sessions, users, subscriptions, closet identity / catalog, avatars, push, and lifecycle email. Auth is Supabase JWT. Data: **D1** (SQL), **R2** (photos), **Vectorize** (closet embeddings), **KV** (PostHog flag defs), **Queues** (async jobs).

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Cloudflare Workers (`wrangler` 4.x) |
| Router | `itty-router` |
| Language | TypeScript (strict), Node **v25** (see `.nvmrc`) |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` |
| Observability | Structured logger → PostHog sink; Worker observability enabled |
| Formatting | Prettier: **tabs**, single quotes, printWidth 140 (`.prettierrc` / `.editorconfig`) |

## Layout

```
src/
  index.ts          # fetch + scheduled + queue entrypoints
  routes/<domain>/  # Router + handlers/ (one handler file per endpoint)
  middlewares/      # auth, admin key, dbId, feature flags, logging
  services/         # domain logic; many use providers/*.provider.ts factories
  db/               # D1 access helpers
  queues/           # queue consumers (dispatched from src/queues/index.ts)
  jobs/             # cron / scheduled job runners
  llm/              # prompts + JSON schemas
  config/           # e.g. FeatureFlags keys enforced by the API
  utils/            # shared helpers (errors, limits, logger, …)
db/
  schema.sql        # full schema bootstrap
  migrations/       # incremental SQL
test/               # *.spec.ts (Workers test pool)
docs/               # product/architecture notes (prefer these over guessing)
scripts/            # migrate.sh, backfills
wrangler.jsonc      # bindings (local copy; see wrangler.example.jsonc)
.dev.vars           # local secrets (gitignored); copy from .dev.vars.example
```

Path aliases resolve from `src/` (`baseUrl` in `tsconfig.json`): e.g. `middlewares/...`, `services/...`, `utils/...`, `types/...`, `db/...`, `routes/...`.

## Commands

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill real secrets
npm run dev                      # wrangler dev
npm run dev:scheduled            # local + --test-scheduled (cron probes)
npm test                         # vitest
npm run db:migrate               # scripts/migrate.sh (default: local)
npm run db:init:local            # apply db/schema.sql locally
npm run cf-typegen               # regenerate worker-configuration.d.ts
npm run check:size               # gzipped Worker size vs 1 MB limit
npm run deploy:staging | deploy:prod
```

Do **not** invent new top-level scripts unless needed; extend existing ones.

## Architecture invariants

### HTTP

1. Mount new domains in `src/index.ts` with `router.all('/…/*', …Router.fetch)`.
2. Domain routers live in `src/routes/<name>/index.ts` with `Router({ base: '/…' })`.
3. Handlers are default-exported functions in `handlers/*Handler.ts`.
4. Auth: `authMiddleware` (Bearer JWT) and/or `adminApiKeyMiddleware`; user-scoped routes usually also use `dbIdMiddleware`.
5. Attach logging via `request.log` (from `loggingMiddleware` / root fetch). Prefer `log.info|warn|error|debug` with snake_case event names — not `console.log` in new code.
6. Client errors: use `apiError(status, message, code?)` from `utils/error`. Codes are auto-prefixed `STYLENS_`. Expected client failures (limits, not found, upload timeout) should log as **warn**, not error (`logRouteError` / `isExpectedClientError`).

### Providers

Swappable integrations follow **factory + `providers/*.provider.ts`** (LLM, email, avatar, segmentation, catalog, embed, …). Prefer adding a provider and a factory case over hard-coding a single vendor in call sites. Env vars often select the active provider (see `.dev.vars.example` comments).

### Queues & cron

- Producers/consumers are declared in `wrangler.jsonc`. Bare queue names locally; remote often `stylens-<name>`. Matching helpers live in `src/queues/index.ts` (`isNamedQueue`).
- New queue work: handler under `src/queues/`, register in `dispatchQueue`, add bindings in wrangler (+ example).
- Scheduled work runs from `src/index.ts` `scheduled` → `src/jobs/*`. Gate with env flags (e.g. `*_CRON_ENABLED`) when adding lifecycle jobs.

### Feature flags

API-enforced PostHog keys belong in `src/config/featureFlags.ts` and must stay aligned with the mobile app / PostHog dashboard. Do not put app-only UI flags here. Flag definition cache uses KV binding `FLAG_DEFINITIONS`.

### D1

- Schema changes: add SQL under `db/migrations/`, apply via `npm run db:migrate`. Update `db/schema.sql` when the migration is part of the canonical bootstrap.
- Access data through `src/db/*` helpers — avoid raw SQL scattered in handlers when a helper already exists.
- Closet Vectorize index is **DINOv3 1024-d cosine**. Do not reuse older CLIP 768-d indexes.

### Limits & subscriptions

Free-tier trial / monthly quota behavior is documented in `docs/subscription-limits.md`. Executable scenarios: `test/effectiveLimits.spec.ts`. Prefer changing `utils/effectiveLimits.ts` + tests over one-off handler checks.

## Testing

- Put tests in `test/<area>.spec.ts` using Vitest + `cloudflare:test` (`env`, `SELF`, `createExecutionContext`).
- Prefer covering gates, limits, queue dispatch, and DB helpers with focused unit/integration tests over large end-to-end flows.
- After behavior changes that have existing specs, run `npm test` (or the relevant file) before finishing.

## Docs to read before large changes

| Topic | Doc |
|-------|-----|
| Subscription / free limits | `docs/subscription-limits.md` |
| Session memory | `docs/session-memory.md` |
| Closet identity / outfit identity | `docs/plan_closet_item_identity.md`, `docs/outfit_identity_flow.md`, `docs/identity_manifest.md` (fixture ground truth) |
| Outfit twin pipeline | `docs/outfit_twin_pipeline.md` |
| Blurhash backfill | `scripts/BACKFILL_BLURHASH.md` |

Plans under `.cursor/plans/` are working notes; treat `docs/` as the durable source when they conflict.

## Do / don’t

**Do**

- Match neighboring file style (tabs, naming, handler shape, provider pattern).
- Keep Worker bundle lean (`npm run check:size` if adding heavy deps).
- Use existing middlewares and logger context (`request_id`, auth ids).
- Update or add Vitest coverage for limit/gate/queue behavior.

**Don’t**

- Commit `.dev.vars`, secrets, or real API keys. Use `.dev.vars.example` / wrangler secrets for production.
- Commit `wrangler.jsonc` secrets or rewrite production binding IDs casually — prefer documenting via `wrangler.example.jsonc`.
- Add large new dependencies without a clear Workers-compatible reason.
- Replace provider abstractions with one-off HTTP calls in handlers.
- Change free-tier semantics without updating `docs/subscription-limits.md` and `effectiveLimits` tests.
- Run destructive remote D1 / deploy commands unless the user explicitly asks.

## PR / change hygiene

- Small, purposeful diffs. No drive-by refactors or unsolicited markdown.
- Summarize **why** in commit messages when asked to commit.
- Prefer linking related `docs/` and tests in the PR description for product-facing behavior (limits, email, closet identity).
