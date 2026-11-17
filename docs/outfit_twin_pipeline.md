# Building an Outfit-to-Twin Try-On Pipeline

**Build the whole pipeline as 2D generative compositing, not 3D.** Use Google's Gemini image model (Nano Banana) as the primary engine for the neutral twin and garment layering, SAM 2 plus a human-parsing model for extraction, and a dedicated try-on model (CatVTON or FASHN's API) where fidelity matters. A true rigged 3D avatar is the intuitive way to read "twin + layers," but in 2026 it is slower, more expensive, and worse at preserving garment detail. The reliable, efficient path treats every stage as an image operation and only reaches for 3D if the product genuinely needs a rotatable body.

---

## I. The Architecture Decision

### 1. 2D generative compositing — *Recommended*

Every stage is an image-to-image operation. The "twin" is a generated image of the same person in a neutral base layer; garments are segmented from the input and re-applied to that image via a try-on model. This is what production tools (Google Shopping try-on, FASHN, Botika) actually run on.

- Seconds per image, cents per call, no GPU fleet to operate if you use hosted APIs.
- Preserves prints, logos, and fabric texture far better than 3D reconstruction.
- Limitation: output is a set of poses/images, not a freely rotatable body.

### 2. True 3D avatar — *Only if required*

Reconstruct a rigged 3D body, then dress it with 3D garments. This is the literal reading of "twin with layered items," and the right call only if users must rotate the body, animate it, or view it in AR/VR.

- Meshy and Avatar SDK (MetaPerson) build a rigged full-body model from one photo in ~1 min, export GLB/FBX.
- Garment fidelity is weaker: single-photo 3D infers the back and occluded regions, so prints and fit drift.
- Heavier compute, more moving parts, harder to keep "reliable" at scale.

### 3. The efficiency trap to avoid

Do not build a 3D reconstruction pipeline to get a 2D presentation. If the end experience is a flat card showing the avatar in an outfit with items layered over it, 3D adds cost and failure modes for a visual you can produce directly with image models. Pick 3D for the interaction model, never for the render.

---

## II. The Pipeline, Stage by Stage

### Stage 1 — Analyze the input

Parse the body and pose before touching pixels. This gives you masks and keypoints every downstream stage reuses.

- **Pose:** MediaPipe Pose (fast, on-device capable) or DWPose for higher accuracy.
- **Human parsing:** a segmentation model that labels regions (hair, torso, arms, top, bottom, shoes) — SCHP or a DensePose-style parser.
- **Quality gate:** reject inputs that are cropped, heavily occluded, or non-frontal here, not after generation.

### Stage 2 — Generate the neutral twin

Produce the same person in a plain base layer. Feed the input photo to an identity-preserving image editor with an instruction like "same face, body, and pose; replace clothing with a plain neutral fitted base layer."

- **Primary:** Gemini image model (Nano Banana) — strong identity preservation, prompt-driven edits, one API call.
- Cache the twin per user so you generate it once, not per outfit.
- If you need a rotatable twin instead, this is where Meshy / Avatar SDK slots in.

### Stage 3 — Extract each outfit item

Cut garments out cleanly and classify them. Combine the Stage 1 parsing map with promptable segmentation to isolate each piece.

- **Segmentation:** SAM 2 (Meta) for high-quality promptable masks; guide it with the human-parsing labels to split top / bottom / outerwear / shoes.
- **Cleanup:** BiRefNet or rembg for crisp alpha mattes and background removal.
- **Optional flatten:** a flat-lay / ghost-mannequin step turns the worn item into a clean product image for the catalog view.

### Stage 4 — Layer garments onto the twin

Re-dress the neutral twin with each extracted item. This is the try-on step, and where model choice most affects realism.

- **Hosted, reliable:** FASHN's try-on API — purpose-built, developer-friendly, up to 4K.
- **Self-hosted, efficient:** CatVTON — 899M params, no pose/parsing preprocessing needed, ~49% less memory than peers (ICLR 2025).
- **Highest fidelity open model:** IDM-VTON — heavier, best detail retention.
- **Prompt-driven alternative:** Gemini image model can layer directly from garment + twin references, letting one model span Stages 2 and 4.

---

## III. What to Actually Ship

### Fastest reliable MVP — *Start here*

Gemini image model for Stages 2 and 4, SAM 2 for Stage 3. One foundation model handles the twin and the layering through prompting; you add segmentation only for clean item extraction. Minimal infrastructure, everything behind hosted APIs, tune quality with prompt engineering before investing in dedicated models.

### Scale / cost-control build

Swap the layering stage to a dedicated try-on model. When per-image API cost or garment fidelity becomes the constraint, move Stage 4 to FASHN's API (managed) or self-hosted CatVTON on your own GPUs (cheapest per image at volume). Keep SAM 2 and the parsing stack; keep Gemini for the neutral twin.

### Reliability guardrails

- **Gate inputs early** — full-body, frontal, unoccluded, decent lighting. Most failures are bad inputs, not bad models.
- **Cache aggressively** — the twin is per-user; extracted garments are per-item. Regenerate only the composite.
- **Async, queued jobs** — treat generation as a background pipeline with retries, not a synchronous request.
- **Consistency** — pin one neutral base layer and one pose set so every outfit reads as the same twin.
- **Provenance** — Gemini output carries SynthID watermarking; plan for it if you re-process images.

---

## IV. Provider Reference

| Role | Pick | Notes |
| --- | --- | --- |
| Neutral twin (2D) | Gemini image (Nano Banana) | Identity-preserving edits, ~cents/image, hosted |
| Twin (3D, optional) | Meshy / Avatar SDK | Rigged full-body from one photo, GLB/FBX |
| Segmentation | SAM 2 | Promptable masks; guide with parsing labels |
| Matting / bg removal | BiRefNet / rembg | Clean alpha for item extraction |
| Try-on (hosted) | FASHN API | Purpose-built, up to 4K, dev API |
| Try-on (efficient OSS) | CatVTON | 899M params, low memory, no preprocessing |
| Try-on (max fidelity OSS) | IDM-VTON | Heavier, best detail retention |

Self-hosted models (CatVTON, IDM-VTON, SAM 2) can run on Replicate or your own GPUs while you validate demand, then move in-house for cost.

---

## V. 2D MVP — API Flow & Data Model

### Request lifecycle

The client uploads once; everything after is asynchronous. Generation is slow and failure-prone, so never block an HTTP request on it.

```
POST /outfits              (multipart: user_id, photo)
  → validate + store photo to object storage
  → enqueue job(outfit_id)
  → 202 Accepted { outfit_id, status: "queued" }

WORKER picks up job(outfit_id):
  1. analyze    → pose + parsing map
  2. twin       → get-or-create neutral twin for user_id  (cached)
  3. extract    → per-item masks + alpha PNGs
  4. compose    → try-on render(s) of twin + items
  → update outfit.status at each step

GET /outfits/{outfit_id}   → { status, twin_url, items[], render_urls[] }
     status ∈ queued | analyzing | extracting | composing | done | failed
```

Poll `GET` or push status over websocket/SSE. Each stage writes its artifacts to storage and advances `status`, so a crash resumes from the last completed stage instead of restarting.

### Stage-by-stage calls

| Stage | Service call | In → Out |
| --- | --- | --- |
| 1. Analyze | MediaPipe/DWPose + SCHP (self-hosted) | photo → `pose.json`, `parsing.png` |
| 2. Twin | Gemini image API (edit) | photo + prompt → `twin.png` |
| 3. Extract | SAM 2 (masks) + BiRefNet (alpha) | photo + parsing → `item_*.png` (RGBA) |
| 4. Compose | FASHN API *or* CatVTON | twin + item → `render_*.png` |

**Stage 2 prompt (Gemini):** `"Keep this person's face, body shape, and pose identical. Replace all clothing with a plain, neutral, fitted base layer (solid light grey). Studio background, even lighting."` Pass the source photo as the image input; request a fixed aspect ratio so every twin is consistent.

**Stage 4 (FASHN):** send `{ model_image: twin_url, garment_image: item_url, category: "tops" }` per item; layer bottoms/outerwear by feeding the previous render back in as `model_image`. CatVTON takes the same two-image input if self-hosted.

### Data model

```sql
users
  id, created_at

twins                        -- one reusable neutral base per user
  id, user_id, image_url,
  pose_json, base_layer_style, created_at

outfits                      -- one per uploaded photo
  id, user_id, twin_id,
  source_photo_url,
  status,                    -- queued | analyzing | extracting | composing | done | failed
  error, created_at

garment_items                -- one per extracted piece
  id, outfit_id,
  category,                  -- top | bottom | outerwear | shoes | accessory
  mask_url, cutout_url,      -- alpha PNG
  flatlay_url                -- optional ghost-mannequin product image

renders                      -- composited presentation images
  id, outfit_id,
  item_ids[],                -- which layers are in this render
  image_url, pose,
  model_used, created_at
```

Key relationships: a `twin` is reused across many `outfits` (generate once, cache); an `outfit` fans out to many `garment_items`; `renders` reference the item layers they contain so you can re-compose subsets (e.g. top only, full look) without re-extracting.

### Idempotency & cost control

- **Cache keys:** twin = `hash(user_id, base_layer_style)`; extraction = `hash(source_photo)`; render = `hash(twin_id, sorted(item_ids), pose)`. Re-requests hit cache, not the model.
- **Retries:** wrap each model call with bounded exponential backoff; mark `failed` only after the stage exhausts retries, and persist which stage failed.
- **Cost guardrail:** meter model calls per user; the twin and extraction are one-time, so steady-state cost is just Stage 4 composites.

---
*Drafted with Dia*
