# Plan 2 — Research: worn garment → twin (lab track)

**Goal:** Learn whether we can put *the user’s actual piece* on the twin well enough that a stranger can match the result back to the closet photo. This is **not** a ship target. Plan 1 is the product.

**Why a separate plan:** SAM masks and Lens stand-ins are the wrong inverse of try-on. Production try-on (FASHN, Google, Zalando) expects a canonical garment photo. The missing research step is **virtual try-off (VTOFF)** or **person-to-person try-on**, plus fashion parsing for layers.

---

## Hypothesis

A parsing mask + try-off model can emit a tiled/flat garment that FASHN will accept, and that output will beat SAM-RGBA-on-FASHN on single-layer, frontal, well-lit items. Layered outfits (open shirt over tee) and inferred backs will still fail.

If the 20-image eval below fails, stop. Do not productize.

---

## Non-goals

- Replacing closet identity (boxed original photo stays Plan 1).
- Multi-view / rotatable 3D (LayGA, GaussianVTON need video or many views).
- SKU-level retrieval as a substitute for reconstruction (that is shopping, already in Plan 1).
- Training a foundation model. Use published weights / hosted demos first.

---

## Tracks (priority order)

### Track 1 — Try-off then FASHN (primary)

**Task:** dressed person + garment mask → canonical flat / tiled cloth → existing FASHN on the twin.

Papers / starting points:

- [TryOffAnyone](https://arxiv.org/abs/2412.08573) — mask-conditioned tiled cloth from a worn photo.
- TryOffDiff / MGT — diffusion try-off, multi-category embeddings.
- [AlignVTOFF](https://arxiv.org/abs/2601.02038), [BridgeDiff](https://arxiv.org/html/2603.09236v1) — newer fidelity / occlusion work.
- ICPR 2026 note: VTOFF as the complement to person-to-person VTON ([What Matters in Virtual Try-Off?](https://arxiv.org/abs/2604.08716)).

**Prototype:**

1. Fashion parser (ATR / SCHP / SegFormer-ATR as in TryOffAnyone) → per-item mask. Do **not** use extract bounding boxes as the mask.
2. Run one try-off model on that mask (hosted demo or Fal/Replicate if available; otherwise a one-off GPU notebook).
3. Feed the flat JPEG to current `TryonService` (`garment_photo_type=flat-lay`) with the user’s twin.
4. Compare side-by-side: SAM cutout → FASHN vs try-off → FASHN vs Plan 1 catalog product → FASHN.

**Expect to break:** open outerwear over a base layer, accessories, heavy folds, logos on the back, elevator selfies with truncated legs.

### Track 2 — Person-to-person try-on (parallel spike)

**Task:** skip the flat image. Transfer the worn garment onto the twin in one shot.

Starting points: [StreetTryOn](https://arxiv.org/abs/2311.16094), PastaGAN++, Any2AnyTryOn, OmniVTON++.

Our twin is a relatively clean studio-ish body, so street-background failure modes in those papers matter less than identity bleed and layer mix-ups.

Run this **only** if Track 1’s flats look plausible but FASHN still warps them. One weekend spike, same eval set.

### Track 3 — Parsing quality (unblocks 1 and 2)

Extract boxes cannot split overlapping garments. A human-parsing map (top / outer / bottom / shoes) is the real segmentation input; SAM is at most a refine step on a parser region.

Do not spend more time on SAM-3 noun prompts for this lab.

### Track 4 — Consumer-to-shop (optional, not reconstruction)

DeepFashion / Street2Shop style retrieval: when Lens hits the real SKU, that is a **shop** win for Plan 1, not proof of reconstruction. Log hit-rate on the eval set; do not use it to grade Track 1.

### Parked

3D Gaussian layered avatars, Meshy-dressed GLBs, self-training on Stylens photos. Revisit only if Plan 1 needs rotate/AR and capture becomes multi-view.

---

## Eval protocol

Fixed set, scored by humans (you + one other if possible). No FID as a ship gate.

**Set A — should work (n ≈ 12)**  
Full-body or 3/4, frontal, even light, **one** dominant layer per category (plain tee, jeans, sneakers). Include a few catalog-like hanging/flat photos if you can shoot them.

**Set B — known hard (n ≈ 8)**  
The elevator selfie, open overshirt over tee, busy prints, truncation, occlusion, two similar colors stacked.

**For each item, store:** original, extract box, parser mask, try-off flat, FASHN-on-twin, Plan 1 catalog FASHN (if any).

**Score (1–5), independently:**

| Criterion | 5 means |
| --- | --- |
| Category/silhouette | Stranger picks the same garment type |
| Color | Matches the worn item, not a neighbor in the photo |
| Print/logo | Survives if visible in the source |
| Twin identity | Face/body still the user |
| Honesty | You would show this in the app as “your item” |

**Pass bar for Track 1:** median ≥ 4 on Set A for silhouette+color, and nobody confuses the result with a different closet item. Set B is diagnostic, not a pass gate.

**Kill criteria:** Set A median &lt; 3, or try-off systematically invents collars/prints. Then the impressive path stays a paper, and Plan 1 remains the product.

---

## Lab setup (keep it off the product path)

- Admin-only endpoints or a notebook. Do not enqueue try-off on `POST /outfits/extract`.
- Artifacts under `research/tryoff/{runId}/`, not `closet_items`.
- Reuse: R2 originals, extract JSON, twin keys, FASHN `TryonService`.
- New: parser + try-off caller only.
- Budget: cap Fal/Replicate spend per run; 20 images × a few variants is enough.

---

## Sequence

1. Freeze the 20-image set and Plan 1 boxed-detail screenshots (so “better” has a baseline).
2. Parser masks on Set A; inspect overlaps by eye.
3. One try-off model on Set A → FASHN.
4. Score. If pass bar missed, try a second try-off weight **once**, then stop or spike Track 2.
5. Only if Set A passes, run Set B and write a one-pager: what capture rules would make this shippable (hanger photos, no layered outerwear, etc.).

---

## If it ever graduates to product

It becomes an **optional “dress twin in this logged item”** behind a quality gate (parser confidence, single layer, full garment visible). Closet detail stays the boxed original. Copy must say the render is generated, not a photo of them wearing it.

Until that gate exists, do not put try-off output in the closet grid.
