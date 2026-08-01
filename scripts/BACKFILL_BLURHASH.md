# BlurHash backfill

One-shot script that fills `blur_hash` / `image_blur_hash` for existing style-analysis images by reading R2 objects and updating D1. R2 objects are not modified.

## Prerequisites

1. Apply migration `0015_add_blur_hash_columns.sql` (local / staging / prod as needed).
2. Real R2 S3 credentials in `.dev.vars` (not the `dummy` placeholders):
   - `OUTFIT_PHOTOS_BUCKET_ACCESS_KEY_ID`
   - `OUTFIT_PHOTOS_BUCKET_SECRET_ACCESS_KEY`
   - `OUTFIT_PHOTOS_BUCKET_NAME` (e.g. `outfit-photos` or `outfit-photos-prod`)
   - `R2_ACCOUNT_ID`
3. Wrangler auth for the target D1 database.
4. Dev deps:

```bash
npm i -D sharp blurhash
```

(`aws4fetch` is already a runtime dependency.)

## Run

From `stylens-lite-api`:

```bash
# Preview a few keys against remote D1 (default) without writing
npm run backfill:blurhash -- --dry-run --limit 5

# Local D1
npm run backfill:blurhash -- --local --dry-run --limit 5

# Staging worker env + remote D1
npm run backfill:blurhash -- --remote --env staging

# Production (use prod bucket name in vars)
npm run backfill:blurhash -- --remote --env production --vars-file .dev.vars.production
```

Useful flags: `--concurrency 4`, `--delay-ms 100`, `--limit N`, `--vars-file PATH`.

## Notes

- Source of truth is D1 keys (`style_analysis_entry_images` + session covers), not a full R2 bucket list.
- Idempotent: only rows where the hash column is `NULL` are updated.
- Missing R2 objects are logged and skipped.
- Component size is **4×3**, matching the Flutter encoder.
