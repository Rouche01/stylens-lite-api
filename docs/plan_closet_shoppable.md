# Plan 1 — Shippable closet + shoppable twin

**Goal:** Users trust what they own, and can see themselves in pieces they might buy. Closet identity stays on *their* photo. Try-on is reserved for catalog garments that already have product images.

This replaces the previous bet (SAM cutout → FASHN on the twin) as the production path.

---

## Product rules

1. **Closet identity** is the worn photo plus extract attributes (`label`, `category`, `subcategory`, `color`, `pattern`, `style_tags`) and wear history.
2. **Grid thumbnail** is decorative: Isolate first (already shipped). SAM or catalog search are optional later thumbs, never the source of truth.
3. **Item detail** is the **full original outfit photo** with this item’s **bounding box drawn on it**. Do not open a zoomed crop as the primary detail view.
4. **Catalog / Lens results** are “similar to shop,” never presented as the user’s garment.
5. **Twin try-on** uses shoppable (or at least catalog-flat) product photos, not SAM RGBA cutouts.

---

## UX

### Closet grid

Each tile: Isolate thumbnail (`isolated_image_url`) + short label/color. Empty isolate falls back to a padded crop of the same box (no `segment: foreground`).

### Item detail (the enhancement)

Tap a tile → full-bleed original image, box overlay, attributes, wear history.

- One box per selected item; the rest of the outfit stays visible so the piece reads in context.
- Wear history: tapping a past wear shows **that** photo with **that** event’s box, not a reused crop from the latest wear.
- Optional: light dim outside the box; keep the photo readable.
- Client draws the overlay from percent `bounding_box` (`x, y, width, height` on 0–100). No server-composited “annotated JPEG” required for v1.

```
┌─────────────────────────────┐
│  [full outfit photo]        │
│     ┌──────────────┐        │
│     │ olive jacket │        │
│     └──────────────┘        │
│                             │
└─────────────────────────────┘
  Olive jacket · worn 3×
  Similar to shop →
  Try on twin →  (shoppable only)
```

---

## What already exists

| Piece | Status |
| --- | --- |
| `POST /outfits/extract` | Claude extract + D1 closet + percent boxes |
| `GET /closet/items`, `GET /closet/items/:id` | Attributes, box, `original_image_url`, Isolate URL |
| `GET /assets/isolate` | CF Images crop + `segment: foreground` |
| Twin | `POST /users/avatars/generate`, R2 `avatars/{userId}/{avatarId}.png` |
| FASHN try-on | Admin `POST /outfits/tryon/generate` (expects a garment image key) |
| Catalog / Lens | Admin `POST /outfits/catalog/search` (scratch JPEG, not shop-out) |

Gaps: stored `original_image_url` can expire (signed at extract time); detail view needs a **fresh signed URL + `image_key` + box**. Catalog search does not yet return a product page or persist a shoppable ref. Try-on is admin-only and still aimed at cutouts.

---

## Slice A — Closet grid + boxed detail (client + small API)

**API (this repo)**

- On `GET /closet/items` and `GET /closet/items/:id`, always return:
  - `image_key`
  - `bounding_box` (percents)
  - `original_image_url` as a **fresh signed** GET (same helper as try-on/catalog)
  - `isolated_image_url` for the grid
- On details, same for each `wear_history` row (`image_key`, signed URL, that row’s box).
- Do not add a server-side “draw box” image endpoint unless the client cannot overlay (share cards, widgets). If needed later: CF Images or a tiny canvas worker; keep it optional.

**Client**

- Grid uses Isolate.
- Detail: signed original + overlay. If the box is missing, show the photo without a box; do not invent a crop-as-detail.
- History list: thumb = Isolate of that wear; tap = that wear’s full photo + box.

**Done when:** tap-through on a real extract (including the elevator selfie) shows the whole scene with a stable box, not a cutout.

---

## Slice B — Thumbnail policy (no identity swap)

Keep Isolate as the only production thumbnail.

- SAM cutouts and catalog JPEGs stay admin/scratch. Do not write them onto `closet_items` as the display image.
- If a catalog thumb is shown at all, label it **Similar**. Prefer it on a “shop this look” row, not on the closet tile.
- Dedup (`color + subcategory + pattern`) is unchanged in this plan; it still collapses distinct physical items. Call that out in UI copy if two olive jackets merge. Visual identity / Vectorize dedup is [Plan 3](./plan_closet_item_identity.md).

---

## Slice C — Twin wearing shoppable recommendations

This is the selling feature. Closet extract is the **query**; the garment image is a **retail photo**.

**Recommend**

- Input: user twin (ready) + closet item attributes (and optionally the boxed crop as a visual hint for search).
- Search: Lens/Shopping (existing SerpAPI path) but keep **product image URL, title, source, product link** — do not treat the copied scratch JPEG as the SKU.
- Rank: prefer retailer/product hits over social; drop results with no usable garment photo.
- Honesty: copy is “pieces like yours,” not “this is your jacket.”

**Try-on**

- `garmentImageKey` / garment URL = catalog product photo (flat or on-model shop shot).
- `avatarImageKey` = ready twin.
- Map extract category → FASHN `tops` / `bottoms` / `one-pieces` (already in `tryon.svc.ts`).
- Layer looks by feeding the previous render back as the avatar (already documented on the admin try-on handler).
- Persist renders under something like `tryon/{userId}/{recId}.png`, not only `tryon/scratch/`.

**Product API (after admin proves it)**

- `GET /closet/items/:id/recommendations` → similar products (image, title, link, optional price).
- `POST /tryon/shoppable` (auth) → `{ closetItemId, productImageUrl | productImageKey, clothType }` → twin render.
- Gate: no ready twin → prompt avatar capture (full-body framing already exists). Do not try-on from a cropped selfie.

**Out of slice C:** dressing the twin in the user’s SAM cutout; ghost-mannequin of the worn item; 3D.

---

## Sequencing

1. Slice A (boxed detail) — highest trust, mostly client, small sign-URL fix.
2. Slice C admin: catalog search returns product metadata → FASHN on twin with that JPEG → eyeball 10 items.
3. Slice C user-facing recs + try-on, behind the same admin/key or a feature flag.
4. Slice B only if Isolate thumbs are ugly enough to need SAM; catalog never becomes the tile.
5. Closet visual identity (Plan 3) is independent and can wait until duplicate tiles hurt more than recs.

---

## Success

- Users can explain what they own from the boxed photo in one glance.
- A recommendation try-on is judged against the **product photo**, not against the selfie crop.
- No support tickets of the form “the app replaced my clothes with a different jacket” on closet tiles.

---

## Explicitly not this plan

Virtual try-off, person-to-person transfer of *their* garment, human parsing for layered split, 3D Gaussians. Those are Plan 2.
