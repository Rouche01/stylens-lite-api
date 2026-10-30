# Identity ground-truth manifest

Stable garment IDs for fixture sets. Labels survive re-smoke: you assign each extracted item to a garment once; replay and metrics join by `garment_id` (and IoU against the photo's box), not by smoke run index.

**Location:** `<fixture-set>/manifest.json` (default set: `../outfits-set-v1/manifest.json`). Versioned seed copy: `tools/outfit-eval-ui/seed/outfits-set-v1.manifest.json`.

**Eval UI:** `npm run eval:ui` → pick a smoke → per item, choose **Ground truth garment**. Creating a garment prompts for a freeform name (prefilled from the extract label so you can correct wrong color/type). The name field under the picker stays editable. Save writes `labels.json` (`garment_id` on each item) and updates the manifest.

## Schema

```json
{
  "version": 1,
  "set": "outfits-set-v1",
  "updated_at": "ISO-8601",
  "garments": [
    {
      "id": "g_apr3_hat",
      "description": "olive/sage baseball cap",
      "slot": "accessory",
      "subcategory_hint": "hat",
      "status": "confirmed",
      "notes": ""
    }
  ],
  "photos": {
    "20260403_093203.jpg": {
      "garments": [
        {
          "id": "g_apr3_hat",
          "box": { "x": 42, "y": 3, "width": 15.8, "height": 7.8 },
          "notes": ""
        },
        {
          "id": "g_apr3_tee",
          "missing": true,
          "notes": "inner green shirt under jacket — not extracted"
        }
      ],
      "notes": ""
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `garments[].id` | Stable id (`g_<cycle>_<kind>`). Never reuse for a different physical piece. |
| `garments[].slot` | Identity slot: `upper` \| `lower` \| `full_body` \| `footwear` \| `accessory`. |
| `garments[].status` | `confirmed` (labeled) or `provisional` (seeded from smoke, needs a human pass). |
| `photos[file].garments[].box` | Rough percent xywh for IoU matching after re-extract. Prefer a labeled smoke's box. |
| `photos[file].garments[].missing` | Present on the person but not extracted (`true`). No box required. |

## Seeded cycles (Oct 2026)

| Cycle | Photos | Confirmed garments |
| --- | --- | --- |
| Apr3 | `20260403_093203`, `_093321`, `_094058` | hat, jacket, tee, jeans, boots |
| IMG_3009 | `IMG_3009`, `B016F629-…`, `IMG_0379` | jacket, jeans, cap (p1), sneakers; hoodie, bag, beige pants, sambas, cap (p2–3); cream sweater, gray pants |
| IMG_0462 | `IMG_0462`, `IMG_0472` | provisional — unlabeled smoke only; confirm in eval UI |

Recall for identity metrics counts only garments with at least one non-`missing` photo occurrence that the extractor returned (see Goals in `plan_closet_item_identity.md`).

## Probe artifacts (smoke)

Admin `POST /outfits/extract` returns `identity_probe` on each embedded item. `npm run extract:smoke` writes those into `tmp/extract_smoke/smoke_*.json` and downloads crop JPEGs to `tmp/extract_smoke/work/<stamp>/crops/`.

## Extract cache (`--reuse-extract`)

Every successful live extract writes a snapshot under `tmp/extract_smoke/extract_cache/` keyed by `sha256(image bytes)` + a short hash of the outfit-extraction prompt, schema, and model env. Cache entries store Claude/Florence items + boxes + `image_dimensions` only (no identity probes).

```bash
# First run (or after prompt/schema change): populate / refresh cache
npm run extract:smoke

# Later re-smokes: skip Claude + grounding; still upload, embed, match, probe
npm run extract:smoke -- --reuse-extract

# Force Claude again but keep writing cache
npm run extract:smoke -- --reuse-extract --bust-extract-cache
```

Admin extract accepts `cachedExtraction` (admin-only). Smoke rewrites `image_url` to the current upload. Use this when iterating identity / policy so Claude variance does not confound the run.

| Field | Purpose |
| --- | --- |
| `encoder` / `model` / `dimensions` / `vector` | Re-score without calling Replicate |
| `crop_color` | Recompute `identityScore` color agreement |
| `crop_image_key` | R2 scratch key (may be short-lived) |
| `crop_path` | Local JPEG relative to repo root (durable for replay color re-sampling) |
| `crop_width` / `crop_height` | Color sampler geometry |

Items that skip embed (`skip_query`, embed failure) have `identity_probe: null`.

## Offline replay

```bash
npm run identity:replay                 # latest smoke with probes + labels
npm run identity:replay -- --sweep      # ask floor × color penalty × auto-link grid
npm run identity:replay -- --smoke tmp/extract_smoke/smoke_….json --auto-link 0.9
```

Replay walks smoke photos in order, scores each probe against prior ground-truth garments (`garment_id` from labels), and reports rewear recall (ask/auto-link to the correct garment), false asks per photo, and false merges. It does not call Claude, Replicate, or Vectorize.
