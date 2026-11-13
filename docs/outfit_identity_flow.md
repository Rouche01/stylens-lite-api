# Outfit identity analysis flow

How an uploaded outfit photo becomes closet tiles, pending matches, and Vectorize vectors.

**Entry:** classification tags outfit images → `CLOSET_IDENTITY_QUEUE` (`kind: closet_identity`).  
**Core:** `OutfitIdentityService.process` / `resolveMatch` in `src/services/identity/outfitIdentity.svc.ts` (writer in `write/`).  
**Repair:** `closet_vector_repair` + hourly `closet_vector_backfill` scan.  
**No Durable Object** — one writer per user via queue + `identity_inflight`.

## Statuses

Closet indexing: `committed` → `indexing` → `indexed` | `index_degraded`  
Match lifecycle: `pending` → claimed (CAS reserved) → done (`same` / `new`)

## Happy path (queue)

```mermaid
flowchart TD
  A[Enqueue closet_identity job] --> B[Acquire identity_inflight]
  B -->|busy| R[Retry ~30s]
  B --> C[Prior-create searchable gate]
  C -->|budget exhaust| D[Mark index_degraded]
  C -->|stamped| E[Process crops sequentially]
  D --> E
  E --> F{ANN + unindexed D1 probes}
  F -->|ask band| G[Pending match + probe_embed]
  F -->|create| H[D1 tile first + probe]
  H --> I[Best-effort Vectorize upsert]
  I --> J[Enqueue backfill/repair]
  E --> K[Release identity_inflight]
```

## Resolve HTTP

`POST .../resolve` stays off the writer lock and does not return `IdentityBusyError`.

- **same:** CAS + link wear  
- **new:** CAS + D1 create + enqueue index (probe cache; Replicate only if probe missing/stale)  
- Same decision again → 200; opposite → 409 (conflicting decision on the same match)

## Writer busy (409 vs queue retry)

| Path | Busy behavior |
|------|----------------|
| `CLOSET_IDENTITY_QUEUE` | `IdentityBusyError` → retry ~30s; give up after 5 attempts |
| `POST /outfits/extract` (admin/eval) | **409** with busy message — client must retry; not used by app capture |
| `POST .../resolve` | Never busy — stays off `identity_inflight` |

## Degraded window

If Vectorize lags past the searchable-gate budget, tiles become `index_degraded` and the next outfit still runs. Local scoring against recent unindexed/degraded probes (`listRecentUnindexedProbes`) **and** pending-ask probes (`listRecentPendingMatchProbes`) prefers **ask** over silent duplicate creates — including when the ANN query itself throws. Pending asks store `probe_embed` but no closet tile; later outfits still score those crops (neighbor id = the pending match’s candidate tile) so mid-cycle rewear is not starved.

CF Images orient/crop/resize retries once on transient failures (5xx, 429, error **1031**, network timeouts). Per-item embed failure still fails that item only; the rest of the outfit continues.
