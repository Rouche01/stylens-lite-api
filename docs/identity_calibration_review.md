# Identity calibration review protocol

Human-in-the-loop labeling of closet identity runs. Ground truth accumulates in a review sheet; thresholds change only in a later **batch tune** after enough clear labels (target 20–50). Plan: `.cursor/plans/identity_calibration_review_ec9bb163.plan.md`.

## Setup (local)

```bash
npm run identity:sink   # → .cursor/identity_runs/<identity_run_id>.json
npm run dev             # or dev:scheduled
```

Enable closet browse if needed (`FEATURE_FLAG_OVERRIDES={"closet-browse":true}` in `.dev.vars`, `ENV_NAME=dev`).

### Fixture eval cycles (API extract)

End-to-end labeling against the **real** `POST /outfits/extract` path (not a side Claude client).

**Env (`.dev.vars`)** — see `.dev.vars.example`:

| Key | Purpose |
| --- | --- |
| `EVAL_USER_ID` | Dedicated sandbox user UUID. Never a real customer. Reset refuses any other id. |
| `ADMIN_API_KEY` | Admin header for reset + extract |
| `EVAL_API_BASE_URL` | Optional; default `http://127.0.0.1:8787` |

**Cycle rules**

- **Start of cycle:** wipe that user’s closet / outfits / matches **and** sweep all Vectorize vectors with `user_id = EVAL_USER_ID` (`eval:reset`, also run automatically by `extract:smoke`). Reset deletes known D1 item ids **plus** an orphan sweep so neighbors from the previous cycle cannot pollute ask/link scores.
- **After reset:** smoke / `eval:reset` wait ~2.5s so in-flight identity/repair queue jobs drain (stale FK work is also soft-acked). Do not extract the first photo immediately after wipe.
- **Within a cycle:** keep D1 + Vectorize as photos are processed so identity can `ask` / link against earlier fixtures.
- **Next cycle:** reset again before a new batch.

```bash
npm run dev
# optional: npm run identity:sink

npm run extract:smoke
# or: npm run extract:smoke -- /path/to/outfits-set-v1 photo1.jpg photo2.jpg
# debug only: npm run extract:smoke -- --no-reset

npm run eval:ui   # http://127.0.0.1:8788 — boxes + system identity + your labels
```

Smoke JSON lands in `tmp/extract_smoke/` (`source: "api_extract"`). Labels save to `tmp/extract_smoke/labels.json`.

Manual wipe without a full smoke: `npm run eval:reset`.

**Sheet (gitignored):** `.cursor/identity_calibration_reviews.local.md` — one row per extracted item. Do not commit signed URLs or raw images.

## Who does what

| Role | Responsibility |
| --- | --- |
| **Agent** | Pick unlabeled run → present decisions → wait → append sheet rows → set `reviewed: true` on the JSON |
| **You** | Inspect outfit / closet tiles in the app → reply with verdicts in chat |
| **Neither in a review turn** | Change match thresholds, encoder, or identity policy |

The agent binds your reply to the run it just presented (by `identity_run_id`). You do not need to edit the markdown table unless reviewing offline.

## Review turn (agent)

Trigger: “review next”, “label next run”, or start of a paced `/loop` tick.

1. **Fetch** one completed run with `reviewed: false` from `.cursor/identity_runs/` (prefer newest `recorded_at`). If none local, fall back to PostHog / Worker logs keyed by `identity_run_id`.
2. **Present** briefly:
   - `identity_run_id`, outfit / `image_key`, create/ask/fail counts
   - per-item table: label, `identity_status`, `identity_reason`, score, candidate + closet ids
   - how to inspect (session outfit, closet tiles, pending match)
3. **Stop** — wait for verdicts. Do not append yet.
4. **On reply** — append one sheet row per item; set `"reviewed": true` on that run’s JSON.
5. **No code or threshold changes** in this turn.
6. Every N clear labels (or on request) — **summary turn** (confusion-style counts + optional tune proposal). Ship tune only after explicit approval, in a separate PR.

`/loop`: long interval (15–30m) or on-demand; never auto-open threshold PRs from a tick.

## How you reply

Prefer including the run id (especially if several runs are in flight):

```text
4eaaec3d…:
1 different - create ok
2 different - create ok
3 unclear - sneakers embedding failed
```

Item numbers match the order in the agent’s presentation (same order as `items[]` in the run JSON).

### Verdicts

| Verdict | Meaning |
| --- | --- |
| `same` | Same physical garment as an existing / candidate tile — system should have linked or asked |
| `different` | Not the same as that neighbor (or no neighbor) — **create was correct** |
| `unclear` | Can’t judge (bad crop, fail with no tile, ambiguous) — **excluded from batch-tune math** |

Optional: `expected_action` = `create` \| `ask` \| `link`, plus short notes.

Empty wardrobe + `created` / `no_neighbor` is usually `different` + `expected_action: create` when the tile looks right.

### Sheet `source`

| Value | When |
| --- | --- |
| `manual_log` | Chat / log review (default for this protocol) |
| `resolve_same` / `resolve_new` | You resolved a pending match in the app (high trust) |

## Free labels from match resolve

When you tap **same** or **new** on a pending closet match, the API emits `identity_calibration_label` once on the **first successful claim** (not on resume / vector-repair retries).

| App decision | `source` | `human_verdict` | `expected_action` | `system_status` |
| --- | --- | --- | --- | --- |
| `same` | `resolve_same` | `same` | `link` | `ask` |
| `new` | `resolve_new` | `different` | `create` | `ask` |

Failed resolves (`embed_failed`, etc.) do **not** emit a label.

### Agent harvest turn

Trigger: “harvest resolve labels”, or after you resolve matches while the Worker is logging.

1. Find `identity_calibration_label` events in the local Worker terminal (or PostHog).
2. Skip any `match_id` already present in the sheet (`notes` contains `match_id:<uuid>`).
3. Append one sheet row per event (copy logged fields; `identity_run_id` may be empty — join via `outfit_id` + `image_key` + label).
4. Do not ask for a second verdict — the resolve **is** the verdict.

Contract: `src/services/identity/logging/calibrationLabel.ts`.

## After labels

Do **not** retune after each photo. When clear rows approach 20–50:

1. Tabulate `identity_score` for `human_verdict=same` vs `different`.
2. Cluster errors by `system_reason` (e.g. all misses are `skip_query` → crop gate, not threshold).
3. Propose one change set; update `docs/plan_closet_item_identity.md` bands only after approval.
