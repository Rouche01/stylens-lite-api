# Plan 3 — Closet item visual identity (dedup + canonical cover)

**Goal:** Stop treating `color + subcategory + pattern` as the same physical garment. Similar items are not re-added by default. Gray-zone matches notify the user asynchronously; they decide new vs duplicate. Confirmed duplicates can promote a better photo as the closet cover.

**Status:** Plan only. Do not implement until this slice is pulled.

This is closet quality, not shoppable try-on. Plan 1 boxed identity stays the product surface. Plan 2 try-off stays lab.

---

## Product rules

1. **Identity grain is the closet item**, not the whole outfit. An outfit vector answers “have I worn this look?” An item vector answers “is this the same olive shirt?” This plan is the second question.
2. **Embed the oriented bounding-box crop** (Florence box on the EXIF-baked JPEG), not the full selfie. Background walls must not dominate the vector.
3. **Attributes are filters and labels**, not the merge key. Coarse **slot** (`upper` | `lower` | `full_body` | `footwear` | `accessory`) scopes the search so jeans never rank against jackets. Map `top` and `outerwear` both to `upper` so Claude’s jacket-vs-top swap still matches. Color/pattern/label can disagree and still be the same piece. Never filter on the exact extract `category` string.
4. **A duplicate is a new wear, not a new tile.** Always persist the outfit photo. Merge vs create is only about `closet_items`.
5. **The user is the async decider in the gray zone.** High similarity merges silently. Mid similarity stays off the grid as a second tile and asks. Low similarity creates a new item.
6. **Canonical cover is scored, not “latest wear.”** Wear history keeps every photo. Grid Isolate + boxed detail use the cover wear.
7. **VoltMem is not this.** Stylist memory stays VoltMem. Visual identity is Vectorize + D1.

---

## Why current dedup fails

`findMatchingClosetItem` in `src/db/closet.ts` is case-insensitive equality on `category + subcategory + color + pattern`.

| Case | What happens today |
| --- | --- |
| Two different olive jackets | Collapsed into one row |
| Same tee, new photo, Claude says “jacket” vs “button-up shirt” | New row |
| Same tee, same strings | Merged, but cover becomes the **latest** wear (`MAX(created_at)`), even if the crop is worse |

`POST /outfits/extract` always inserts a new `outfits` row and a new `outfit_clothing_items` link. Dedup only reuses `closet_items.id`. That split is correct and stays.

---

## Match bands

Cosine similarity is **not** extract `confidence` (`high` / `medium` / `low` on the Claude item). Extract confidence is a crop-quality gate (“is this box usable?”). Duplicate confidence is **identity_score** (encoder cosine after slot filter, then crop-color agreement). Extract confidence is a crop-quality gate (“is this box usable?”). Cosine alone is not a match: DINOv3 CLS scores ~0.7 for any two clothing crops.

Calibrate thresholds on a labeled set (same garment / different garment / same color different SKU). Do not ship guessed constants. Start **conservative on silent merge** (fewer false joins, more notifications).

```
new crop embedding
        │
        ▼
query Vectorize  filter user_id + slot + encoder
        │
        ├── identity_score ≥ high     → merge silently
        │                      promote cover if new wear scores higher
        ├── high > identity_score ≥ mid → provisional merge (no second tile)
        │                      notify; user can split to a new item
        └── identity_score < mid      → new closet item
                               upsert vector
```

**Ignored / missing notification** defaults to “same” (no extra tile). That is “do not re-add similar by default.”

**If embedding or Vectorize is down:** fall back to create-new (never attribute-equality merge). Log it. Do not resurrect the string key as a safety net; it is how two olive jackets already collide.

---

## Canonical cover (better image)

Today grid/detail cover is the newest `outfit_clothing_items` row. Replace that with an explicit cover pointer on `closet_items`.

**Promote when** the new wear’s representation score beats the current cover by a margin. Never delete the losing photo.

v1 score (no extra model):

- **Area:** `width * height` of the percent box (larger garment in frame).
- **Truncation penalty:** box touching `x≈0`, `y≈0`, or `x+width≈100` / `y+height≈100`.
- **Tightness:** Florence grounding score when present.
- **Reject:** extract confidence `low`, or box area below a floor (tiny false boxes).

v1.5 (optional): frontal-ness / blur only if the v1 score promotes junk.

Cover change updates:

- Which `image_key` + `bounding_box` `GET /closet/items` and `GET /closet/items/:id` treat as primary.
- The **canonical vector** for that closet item (re-embed the new cover crop).

Wear history order stays chronological. Detail “tap a past wear” is unchanged.

---

## Architecture

### Vector store

Cloudflare **Vectorize** (Workers-native, cosine). One index per encoder generation, ids namespaced.

**v1 vector id:** `item:{closet_item_id}` — the cover crop only. Fast, enough to replace string equality.

**v1.5 (if same-shirt different lighting misses):** also upsert `wear:{outfit_clothing_items.id}` and query those, then map to `closet_item_id`. Skip until recall logs say cover-only is weak.

**Metadata — indexed (query filters):**

| Field | Why |
| --- | --- |
| `user_id` | Tenant isolation. Never search another wardrobe. |
| `slot` | Body region. `top`+`outerwear` → `upper`. Not Claude’s exact category. |
| `encoder` | Pin `dinov3-cls-v1` (or the next ReID id). Never mix CLIP/DINO/ReID in one query. |
| `closet_item_id` | Join back to D1. |

**Metadata — stored, not a merge key:** `category` (display), `color_h` / `color_s` / `color_l` (pixel HSL from the crop, used to compute `identity_score`).

**Do not store as identity:** `label`, `subcategory`, `pattern`, Claude `color` string, `style_tags`. Those belong in D1.

### Embedding model

The vector is **pixels of the Florence crop only**. Do not concatenate text.

Workers AI BGE/ResNet and CLIP/FashionSigLIP match “kind of garment,” not the physical piece. Current spike encoder is **DINOv3 CLS** (`dinov3-cls-v1`, 1024-d). It is a weak identity signal; slot + crop-color are required vetoes. Same JPEG can score ~0.97; a new photo of the same piece and a different jacket both land ~0.75.

**Next encoder (new Vectorize index, new `encoder` id):** a fashion **instance** model trained on same-item different-photo pairs (DeepFashion in-shop / consumer-to-shop, GR-Lite, MODA-DeepFashion2). Do not reuse this 1024-d index. Host it (Replicate Cog / GPU worker); swap `IDENTITY_ENCODER` and recreate the index.

Optional later: extra `wear:{id}` vectors per photo, query max-sim, still one closet tile.

### When it runs

Extract (Claude + Florence) stays the request path. Identity match runs **after** the HTTP response:

- v1: `ctx.waitUntil` (same pattern as `ClassificationService.postProcessEntryInBackground` and `PushService.sendPushNotificationInBackground`).
- If waitUntil is too tight once CLIP is in: a Queue, same shape as `AVATAR_GENERATION_QUEUE`.

Extract response may still use a **fast provisional** decision (create-new) and then reconcile in the background. Prefer: extract returns after D1 writes; identity job immediately rewrites the link + cover before the user opens the closet. If they open the closet first, they might see a duplicate for a few seconds; acceptable for v1 if the job is usually sub-2s. If not, hide items with `identity_status = pending` from the grid until the job finishes.

### Notifications

Reuse `PushService` + FCM. Payload `data` keys (all strings, FCM requirement), e.g.:

- `type=closet_match`
- `match_id=…`
- `closet_item_id=…`
- `outfit_id=…`

Copy is a question, not an assertion: “Is this the same olive shirt?” Deep link to a resolve screen. No push on silent high-merge. No push on obvious new items.

### Resolve API (client, later)

- `GET /closet/matches/pending` — candidate vs new crop (signed originals + boxes).
- `POST /closet/matches/:id/resolve` `{ decision: "same" | "new" }`.
  - `same`: keep the wear on the candidate; run cover promotion; clear pending.
  - `new`: insert a new `closet_items` row, reparent the wear, upsert its vector.

Admin can resolve with the existing admin-or-auth middleware while the client screen does not exist.

---

## Data model (sketch)

Do not run this migration until implementation.

`closet_items` add:

- `cover_wear_id` — FK to `outfit_clothing_items.id` (nullable until backfill).
- `identity_status` — `ready` | `pending` (optional, if we hide in-flight items).

New table `closet_item_matches`:

- `id`, `user_id`
- `wear_id` (`outfit_clothing_items.id`)
- `candidate_closet_item_id`
- `score` (real)
- `band` (`high` | `mid` | `low`)
- `status` (`pending` | `same` | `new` | `auto_same`)
- `created_at`, `resolved_at`

Vectorize is the ANN store. D1 remains source of truth for items, wears, cover, and match decisions.

---

## Slices (when we pick this up)

### Slice D1 — Infra + replace string match

- Vectorize binding + wrangler index (cosine, correct dims).
- Crop → embed helper (CF Images box crop of oriented JPEG).
- On extract, after link: query; high → reuse id; low → create; **stop calling `findMatchingClosetItem`**.
- Canonical `cover_wear_id`; grid/detail SQL uses it instead of `MAX(created_at)`.
- Cover promotion on high-merge.
- Tests: box score, band thresholds as fixtures, no live Fal in unit tests.

**Done when:** two extracts of the same tee with different Claude labels share one closet id; two different olive jackets do not; a worse elevator crop does not replace a better cover.

### Slice D2 — Gray zone + notify

- Persist `closet_item_matches` for mid band.
- Provisional merge (no second tile).
- Push via existing FCM path.
- Resolve endpoint.
- Default ignore → stay merged.

**Done when:** a mid-score pair sends one push; “new” splits the wear onto a second tile; “same” keeps one tile and may promote cover.

### Slice D3 — Backfill + calibration

- Admin backfill: embed existing covers, optional one-time merge suggestions (do not auto-merge a user’s whole closet without review).
- Log score histograms (high/mid/low counts) for a week of real extracts.
- Tune thresholds; document the chosen numbers in this file.

**Out of this plan:** outfit-level look embeddings; catalog/SKU retrieval; shoppable twin (Plan 1 Slice C); try-off (Plan 2); VoltMem.

---

## Sequencing vs other plans

1. Plan 1 Slice A boxed detail — done.
2. Plan 1 Slice C shoppable twin — independent; can ship before or after this.
3. **This plan** — whenever closet duplicate pain is higher than recs.
4. Plan 2 — still not a ship target.

Plan 1 Slice B already noted that string dedup collapses distinct items. This plan is that fix.

---

## Success

- Same garment, new selfie → one closet tile, wear count +1, maybe a better cover.
- Two similar-but-different pieces → two tiles, or one mid-band question, never a silent smash.
- Users who ignore the question do not accumulate near-duplicate tiles.
- Extract latency does not wait on CLIP.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| CLIP merges two olive shirts | Conservative high threshold; category filter; mid-band ask |
| Lighting / pose misses the same shirt | Later: per-wear vectors; still never fall back to string equality |
| Wrong box → garbage embedding | Skip identity if extract confidence is `low` or box is truncated/tiny; create new |
| Promoting a tight wrong box | Margin + truncation penalty; never promote `low` |
| Index model change | New index name; backfill; do not mix dims |
