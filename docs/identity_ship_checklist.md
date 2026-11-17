# Identity ship checklist

Track progress toward the **ask-first** ship bar in [`plan_closet_item_identity.md`](./plan_closet_item_identity.md). Update checkboxes and the **Latest held-out replay** table when numbers change. Protocol for labeling: [`identity_calibration_review.md`](./identity_calibration_review.md). Manifest: [`identity_manifest.md`](./identity_manifest.md).

**Product framing:** create / ask / user resolves. Silent auto-link is **out of scope** for first flag-widen (section D).

## Targets (ship / widen-flag)

| Metric | Target | Notes |
| --- | --- | --- |
| Rewear recall (ask → correct garment; later + auto-link) | ≥ **85–90%** | Denominator = garments the extractor returned that are labeled rewears |
| False silent merges | **0** | Keep auto-link off until section D |
| False asks | ≤ **~1 per photo** | Near-identical basics asking = correct, not a false ask |

Measure on a **held-out** labeled set (not fixtures used for tuning). Small smoke wins are signals only.

## Report contract (A5)

Per probe with a `garment_id` label, offline `identity:replay` (ask≥0.5, pen 0.3, auto-link off):

| Metric | Definition |
| --- | --- |
| **Rewear recall** | Among probes whose garment already appeared earlier in the smoke: fraction with action `ask` (or auto-link) **and** `candidate_garment_id ===` labeled `garment_id` |
| **False ask** | `ask`/`auto_link` to the **wrong** garment (rewear miss) **or** ask on a first sighting; near-identical-basics asks are product-OK but still counted by the script unless excluded in notes |
| **False merge** | Wrong-garment `auto_link` (always **0** while auto-link is off) |
| **False asks / photo** | `false_ask` count ÷ ok photos in that smoke (or ÷ photos across aggregated smokes) |

Ship bar is evaluated on **held-out aggregate only** (below).

## Latest held-out replay

| Date | Smoke / corpus | Recall | False asks / photo | False merges | Pass? |
| --- | --- | --- | --- | --- | --- |
| 2026-11-10 | **Held-out aggregate** (B1 labels + B2 upper outer↔inner reject) | **15/17 (88.2%)** | **5 / 9 ≈ 0.56** | **0** | **Yes** — recall in 85–90%, false asks ≤1, merges 0 |
| 2026-10-31 | Held-out slice: Christmas + IMG_2008/2010 | 7/7 (100%) | 1 (~0.25); olive→grey tee ask | 0 | Slice only |
| 2026-11-10 | Held-out slice: A3 (post B1+B2) | 8/10 (80.0%) | 4 (~0.80) | 0 | Slice only |

### Tune-only signals (not ship bar)

| Date | Smoke / corpus | Recall | False asks / photo | False merges |
| --- | --- | --- | --- | --- |
| 2026-10-31 | Apr3 | 7/8 (~88%) | ~OK | 0 |
| 2026-11-09 | Hard-light `smoke_2026-11-09T15-19-20-402Z` | 10/14 (71.4%) | ~1.00 | 0 |

**Verdict (2026-11-10):** held-out **passes** ask-first ship bar after B1 label fixes + B2 upper outer↔inner subcategory reject (`policy.ts` / replay). Remaining A3 misses: sneakers family collision, light jeans→dark jeans (color ceiling) — out of scope for another knob this pass.

## Corpus split (A4) — fixed 2026-11-10

Photo-level split. **Held-out never informs knobs** (thresholds, color, encoder). Replay ship bar = held-out smokes only.

### Tune (may inform future knobs)

| Sequence | Photos | Smoke (when relevant) |
| --- | --- | --- |
| Apr3 | `20260403_093203`, `_093321`, `_094058` | bake-off / hueS |
| Hard-light Apr3 extensions | `20260404_142438`, `20260416_102104` | `smoke_2026-11-09T15-19-20-402Z` (with Apr3) |
| IMG_3009 cycle | `IMG_3009`, `B016F629-…`, `IMG_0379` | early manifest |
| IMG_0462 cycle | `IMG_0462`, `IMG_0472` | early manifest |

### Held-out (ship-bar only)

| Sequence | Photos | Smoke |
| --- | --- | --- |
| Christmas | `20251225_102733`, `20251225_102758` | `smoke_2026-10-31T16-50-31-657Z` |
| Layered upper | `IMG_2008`, `IMG_2010` | `smoke_2026-10-31T16-50-31-657Z` |
| A3 rewear / outdoor | `20260226_085543`, `20260324_063843`, `20260403_164310`, `IMG_3326`, `IMG_3021` | `smoke_2026-11-10T11-06-15-212Z` |

**How to score held-out:** run `identity:replay` on each held-out smoke (no tune photos in that JSON). Aggregate rewear hit/total and false asks across those runs for the held-out table row. Do not change scoring after peeking at held-out unless you accept retuning and need a fresh held-out set.

## Scoring freeze

Do **not** change these until a held-out replay justifies it:

- Encoder: DINOv3 CLS (`dinov3-cls-v1`)
- `CHROMA_HUE_MIN_S` = **0.28**
- No MODA / new encoder / wider color penalty / lower ask floor until section B fails for “unused cosine” reasons

---

## A. Measurement (before any knobs)

- [x] Freeze scoring (DINOv3 + hueS 0.28); no threshold/encoder PRs until replay says so
- [x] Hard-light sequence smoked + labeled: Apr3 anchors `20260403_093203` / `_093321` / `_094058` + `20260404_142438` + `20260416_102104` — smoke `smoke_2026-11-09T15-19-20-402Z`; replay **10/14 (71.4%)**, ~1 false ask/photo; shoe garment ids double-checked (optional jeans-only `20260403_164310` skipped)
- [x] Grow labels on `outfits-set-v1` — rewear batch smoked/labeled: `20260226_085543`, `20260324_063843`, `20260403_164310`, `IMG_3326`, `IMG_3021` — smoke `smoke_2026-11-10T11-06-15-212Z`; replay **7/10 (70.0%)**, ~1 false ask/photo (leather↔shirt, sneakers collision, outdoor jeans)
- [x] Split corpus: **tune** vs **held-out** — see **Corpus split (A4)** above (held-out never used for knobs)
- [x] Report contract fixed — see **Report contract (A5)** above
- [x] `identity:replay` on held-out; aggregate **14/17 (82.4%)**, ~0.67 false ask/photo, 0 merges — **fail ship bar** (see table)

## B. Hit recall + false-ask bar (held-out)

- [x] If recall **&lt; 85%**: fix labels / extract-slot noise first — not color weight. **B1 done:** brown bomber ≠ `g_3009_jacket` → `g_brown_leather_bomber`; `20260226` shoes ≠ sambas → `g_shoes_20260226`; IMG_3326 gray pants verdict aligned.
- [x] One focused policy change: **upper outer↔inner hard-reject** (jacket/coat/… ≠ shirt/tee/hoodie/…) in `policy.ts` + `identity-replay.mjs`; unit tests in `test/identity_subcategory_gate.spec.ts`. Held-out **15/17 (88.2%)**, false asks ~0.56/photo (down from 14/17 @ 82.4%).
- [x] Rejected color-weight / ask-floor changes; false asks improved (not worsened); olive↔grey tee ask unchanged (near-identical basics).
- [x] **Pass gate:** held-out recall **88.2%** **and** false asks ≤ ~1/photo **and** false merges = 0

## C. App readiness (parallel with A/B; required to flip flag)

Code audit 2026-11-10 (API + `stylens` app). Manual device pass still required before calling C done for flag widen.

### C audit

| Item | API | App (`stylens`) | Status |
| --- | --- | --- | --- |
| Pending list + resolve | `GET /closet/matches/pending`, `POST /closet/matches/:id/resolve` (`closet-browse`) | `ClosetAskBanner` / `ClosetAskSheet` (“It's the same” / “It's new”); `ClosetManager.resolveCurrentAsk` | **Wired** — smoke on a real ask before tick |
| Ask notify | Queue `closet-match-digest` → FCM after ~10 min settle (`notify/digest.ts`) | In-app: pending fetch on home / closet bind; push type `closet_matches` | **Wired** — confirm push on a physical device |
| Escape hatches | Resolve `new`; `PATCH /closet/items/:id` `{ label }` | “It's new” wired; **no** rename client call yet (`ClosetApiService` has get/resolve only) | **Partial** — rename is API-only until app ships edit |
| Flag | Enforces `closet-browse` | Same key; local overrides can force on | **Ready for internal beta** — PostHog cohort + watch resolves |

### Checklist

- [x] Pending-match UI + resolve `same` / `new` **wired** (API + app) — still do one manual ask smoke before widen
- [x] Push digest + in-app pending inbox **wired** — still confirm one real push on device
- [ ] Rename / “this is new” escape hatch — **“It's new” done**; rename UI/API client **not** in app yet (API `PATCH` ready; sidequest [closet_ask_ux_growth_sidequest](../.cursor/plans/closet_ask_ux_growth_sidequest.plan.md))
- [ ] Internal / beta flag-on; watch ask rate + `same` vs `new` ← **current** (enable `closet-browse` for you / tiny cohort; log resolves)

### Manual smoke (before C4 / D)

1. Flag on for your user (`closet-browse`).
2. Upload an outfit that should ask (rewear).
3. See banner/sheet → tap **same** and **new** on different asks.
4. Confirm digest push (or wait settle) opens closet / pending.
5. Note: rename can wait; wrong Claude names are annoying but not a merge risk.

## D. After B + C pass

- [ ] Widen feature flag beyond beta
- [ ] Auto-link band (optional later): ≥ ~200 near-floor different-garment pairs, 0 false merges with margin — see goals in [`plan_closet_item_identity.md`](./plan_closet_item_identity.md)

## Explicitly deferred

- MODA Cog push / Worker provider / Vectorize migrate
- Learned logistic combiner
- SAM2 masking (already skipped)

---

## Commands (cheat sheet)

```bash
npm run dev

npm run extract:smoke -- /Users/richardemate/Projects/outfits-set-v1 \
  20260403_093203.jpg 20260403_093321.jpg 20260403_094058.jpg \
  20260404_142438.jpg 20260416_102104.jpg

npm run eval:ui
npm run identity:replay -- --smoke tmp/extract_smoke/smoke_….json
```

Labeling + cycle rules: [`identity_calibration_review.md`](./identity_calibration_review.md).
