# Plan 3 — Closet item visual identity (dedup + canonical cover)

**Goal:** Stop treating `color + subcategory + pattern` as the same physical garment. Similar items are not re-added by default. Gray-zone matches notify the user asynchronously; they decide new vs duplicate. Confirmed duplicates can promote a better photo as the closet cover.

**Status:** Plan only. Do not implement until this slice is pulled.

This is closet quality, not shoppable try-on. Plan 1 boxed identity stays the product surface. Plan 2 try-off stays lab.

---

## Goals & acceptance criteria

Every identity plan, policy change, or scoring change should state which of these it moves and report the numbers.

**Product goal:** the closet builds itself from outfit photos. A rewear links to the existing tile as a new wear; a genuinely new garment creates one tile. Wear counts and closet-aware styling depend on this.

**Error priorities (worst first):**

1. **False merge** — two different garments fused into one tile. Silent corruption, hard to undo.
2. **Missed rewear** — duplicate tile, wrong wear counts. The dominant failure today.
3. **Ask fatigue** — correct but too many questions; the closet stops feeling automatic.

**Bands:**

| Band | Rule | Status |
| --- | --- | --- |
| Auto-link | `identity_score ≥` auto-link floor → link wear silently, with undo | Not built. Enable only when replay shows 0 false merges with margin. |
| Ask | `IDENTITY_MATCH_MIN` (0.5) ≤ score < auto-link floor → pending match | Live (today every match ≥ 0.5 asks). |
| Create | score < 0.5, wrong subcategory, or no neighbor | Live |

**Initial targets** (per slot, on a held-out labeled set, not the fixtures used for tuning):

- Rewear recall (auto-link + ask): **≥ 85–90%**
- False silent merges: **0**
- False asks: **≤ ~1 per photo**
- Auto-link share of true rewears: rises over time (asks shrink as the system earns trust)

Targets are a starting bar; revise them here with the data that justifies the change.

**Definitions and limits:**

- **Recall denominator** is garments the extractor returned. A worn item Claude never extracted (hidden socks, a covered belt) is an extraction miss, tracked separately, not an identity miss.
- **Auto-link evidence bar:** zero false merges in *n* labeled negatives only bounds the true rate at roughly 3/*n* (95%). Do not enable auto-link until the labeled corpus has **≥ ~200 different-garment pairs scoring near the candidate floor** (same slot, within ~0.1 of it) and none cross it.
- **Near-identical basics** (two plain black tees, two pairs of black boots) cannot be told apart from one photo by any current encoder. For these, **ask is the correct outcome**: count an ask as a hit for recall, never auto-link them, and do not count their asks as false asks when the user confirms either way.

**Measurement rule:** no scoring/policy change ships on a single smoke. Report recall, false-ask, and false-merge rates from the labeled replay corpus (plus one held-out smoke) before and after.

**Roadmap (in order):**

1. ~~Measurement: per-garment ground-truth manifest ([`docs/identity_manifest.md`](./identity_manifest.md)), persisted probe artifacts (admin extract `identity_probe` + smoke crop download), offline replay + threshold sweep, extraction cache for re-smokes.~~ **Done** (`extract:smoke --reuse-extract`, `identity:replay`, `identity:bakeoff`).
2. ~~Vendor-free structure: multi-prototype items (confirmed wears add vectors/color; score max over wears), outfit co-occurrence prior, soften the `subcategory` gate within closed-shoe families.~~ **Done**.
3. ~~Masking (SAM2) for footwear/accessory crops~~ — **skipped** (measurement: proxies did not justify per-item cost).
4. ~~Representation / color bake-off~~ — **done for now**: DINOv3 CLS stays; FashionSigLIP/MODA do not beat it under the safe color blend; `CHROMA_HUE_MIN_S` 0.12 → 0.28 shipped; wider color weight rejected (olive-black false asks). Cog scaffold only: `tools/moda-cog/`.
5. **Grow the labeled corpus (next).** No more encoder or color-weight changes on Apr3 alone.
   1. Fix remaining label noise (e.g. Apr3 bag-as-boots).
   2. Add **1–2 new multi-photo sequences** that stress: same garment under hard lighting/WB/angle; near-identical basics in-slot; clean footwear + bag.
   3. Smoke (`extract:smoke`, prefer `--reuse-extract`) → label in `eval:ui` → `labels.json`.
   4. Offline `identity:replay` / `identity:bakeoff --sweep` on DINOv3 with current color rules; report recall / false-ask / false-merge before any knobs move.
   5. **Batch tune only** after ~20–50 clear labels (protocol: [`docs/identity_calibration_review.md`](./identity_calibration_review.md)). There is no auto train/fix loop — human labels → replay → optional threshold PR.
6. Auto-link band, calibrated on the larger replay corpus (≥ ~200 near-floor different-garment pairs; see Goals).
7. Learned combiner over `[cos, Δcolor, subcategory_match, slot, …]` once ~100 labeled pairs exist — only if step 5 still leaves systematic misses that thresholds cannot absorb.
8. Revisit encoder / Cog push (MODA) only if the larger set shows cosine separation that color cannot safely use under DINOv3.

Extraction hygiene (pixel-derived color labels, generic grounding phrases, pinned model / temperature 0) fits between steps. Out of scope: queue / writer / Vectorize / D1 flow, lowering the 0.5 ask floor.

---

## Product rules

1. **Identity grain is the closet item**, not the whole outfit. An outfit vector answers “have I worn this look?” An item vector answers “is this the same olive shirt?” This plan is the second question.
2. **Embed the oriented bounding-box crop** (Florence box on the EXIF-baked JPEG), not the full selfie. Background walls must not dominate the vector.
3. **Attributes are filters and labels**, not the merge key. Coarse **slot** (`upper` | `lower` | `full_body` | `footwear` | `accessory`) scopes the search so jeans never rank against jackets. Map `top` and `outerwear` both to `upper` so Claude’s jacket-vs-top swap still matches. Color/pattern/label can disagree and still be the same piece. Never filter on the exact extract `category` string. **Exception:** within `accessory` and `footwear`, gate on `subcategory` before ask (hat must not ask vs socks). Closed shoes (`boots` / `sneakers` / `loafers`) are soft-compatible with a ×0.85 score penalty; open vs closed footwear stays hard-blocked. Confirmed `same` adds a wear prototype vector (`wear:{matchId}`) so later photos score max over wears.
4. **Outfit co-occurrence prior.** After the first pass, if ≥2 items ask at score ≥0.8 to tiles that share one prior outfit, re-score remaining soft misses (`below_threshold` / `missing_candidate`) only against that outfit’s tile probes (slot filter on, subcategory gate off, ask floor 0.4). Emit `ask` with reason `outfit_prior`. Never auto-link from the prior.
5. **A duplicate is a new wear, not a new tile.** Always persist the outfit photo. Merge vs create is only about `closet_items`.
6. **The user is the async decider in the gray zone.** High similarity merges silently (auto-link band — not yet enabled; see Goals). Mid similarity stays off the grid as a second tile and asks. Low similarity creates a new item.
7. **Canonical cover is scored, not “latest wear.”** Wear history keeps every photo. Grid Isolate + boxed detail use the cover wear.
8. **VoltMem is not this.** Stylist memory stays VoltMem. Visual identity is Vectorize + D1.

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

Crop-color calibration (Oct 2026, labeled smoke set): in-slot DINOv3 cosine has little separating power (different garments 0.94–0.98), so `color_distance` carries the decision. Every labeled different-garment pair sat at Δ ≥ 0.35, while same-garment lighting shifts reached Δ ≈ 0.17. The ramp is therefore `COLOR_DISTANCE_FULL_PENALTY = 0.3` (agreement hits zero at Δ 0.3). To keep Δ honest, `rgbaToColorSignature` weights crop pixels toward the center (edge floor 0.15) and drops the bottom 25% of footwear crops (floor contamination). Brim-only hat boxes (height < `IDENTITY_HAT_BOX_MIN_HEIGHT`) are no longer skipped: `identityEmbedBox` expands them to `IDENTITY_HAT_EXPAND_HEIGHT` (mostly upward) before embedding.

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

**Next encoder (new Vectorize index, new `encoder` id):** a fashion **instance** model trained on same-item different-photo pairs (DeepFashion in-shop / consumer-to-shop, GR-Lite, MODA). Do not reuse this 1024-d index. Host it (Replicate Cog / GPU worker); swap `IDENTITY_ENCODER` and recreate the index.

**Apr3 offline bake-off** (`npm run identity:bakeoff`, ask≥0.5): DINOv3 CLS / FashionSigLIP baseline **5/9**; MODA **4/9**. Color-param sweep (`--sweep`, 1440 configs): raising `CHROMA_HUE_MIN_S` 0.12 → **0.28** recovers the WB/hue-flipped jacket → **7/9** at same false-ask rate, and keeps olive-vs-black below ask. Configs that hit **8/9** (wider `COLOR_DISTANCE_FULL_PENALTY` and/or lower color blend weight) also score olive-black ≥ ask — do **not** ship those until a larger labeled set shows the false-ask trade is acceptable. Remaining 7→9 gap: photo3 bag labeled as boots (slot miss) + jeans sat-shift `cd≈0.35` (same Δ band as different garments). Cog scaffold: `tools/moda-cog/`.

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

#### Run logging (for calibration)

Identity runs emit correlated structured logs joined by `identity_run_id` (minted at enqueue or at the queue consumer / HTTP extract). Contract: `src/services/identity/logging/runLogging.ts`. Human review protocol: [`docs/identity_calibration_review.md`](identity_calibration_review.md) (plan: `.cursor/plans/identity_calibration_review_ec9bb163.plan.md`).

| Event | Use for calibration |
| --- | --- |
| `closet_identity_completed` | Per-photo summary: `created` / `asked` / `failed` / `existing_crop` counts + `items_json` (status, reason, `identity_score`, candidate / closet ids) |
| `identity_vector_queried` | Top cosine / `identity_score` / color distance before decide |
| `outfit_identity_ask` / `outfit_identity_created` | Per-item decision with score + reason (inherits `identity_run_id` via child logger) |
| `closet_identity_enqueue_skipped` / `_result` | Gate / wiring misses vs actually queued photos |

**Local review files (dev only):** when `ENV_NAME=dev`, completed runs POST to a localhost sink that writes one JSON file per run:

```bash
npm run identity:sink   # terminal A → .cursor/identity_runs/<identity_run_id>.json
npm run dev             # terminal B
```

Workers cannot write the host disk, and local R2 is remote in this project — do not put run artifacts in the outfit photo bucket. Sink is fail-open if not running.

Histogram `identity_score` (and create vs ask vs `below_threshold`) from a week of these events before changing match bands. Do not resurrect attribute-equality merge from logs.

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
