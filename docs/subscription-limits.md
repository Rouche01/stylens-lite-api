# Subscription limits

How session, message, and image limits apply to Free and Core users.

**Free plan:** 7 days of unlimited sessions after signup, then 5 sessions per UTC month (plus 20 messages and 10 images per session).

## Tiers

| Tier | Default behavior |
|------|------------------|
| **Free** (`free`) | Trial window, then monthly session quota; per-session message and image caps |
| **Core** (`core`) | Unlimited sessions, messages, and images |

New users are created on the **Free** tier with `subscriptions.has_reached_limit = 0`. Paid upgrades are handled via RevenueCat webhooks (`src/routes/webhooks/handlers/revenueCatWebhookHandler.ts`).

## Default limits (environment)

Configured via Worker env vars (see `.dev.vars.example` and `wrangler.example.jsonc`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `FREE_TIER_TRIAL_DAYS` | `7` | Days after signup during which trial rules apply |
| `FREE_TIER_TRIAL_SESSION_LIMIT` | `-1` | Max sessions during trial (`-1` = unlimited) |
| `FREE_TIER_MONTHLY_SESSION_LIMIT` | `5` | Max sessions per UTC calendar month after trial |
| `FREE_TIER_MESSAGE_PER_SESSION_LIMIT` | `20` | Max messages per session (trial and post-trial) |
| `FREE_TIER_IMAGE_PER_SESSION_LIMIT` | `10` | Max images per session (trial and post-trial) |

`-1` always means **unlimited** for that dimension.

## Free-tier lifecycle

### 1. Signup

`POST /users` creates:

- A `users` row (`created_at` anchors the trial window)
- A `subscriptions` row: `tier = free`, `status = active`, `has_reached_limit = 0`
- Optionally a `user_limits` row if the user redeemed an invite code

### 2. Trial (first N days)

While `now < user.created_at + trialDays`:

- **Session limit:** `FREE_TIER_TRIAL_SESSION_LIMIT` (default: unlimited)
- **Counting window:** sessions since `user.created_at`
- **Message / image limits:** still enforced per session

### 3. Post-trial (monthly quota)

After the trial ends:

- **Session limit:** `FREE_TIER_MONTHLY_SESSION_LIMIT` (default: 5)
- **Counting window:** sessions since the **start of the current UTC month**
- Quota **resets on the 1st of each UTC month**

### Important: trial sessions count toward the monthly quota

When trial ends mid-month, session counting switches from “since signup” to “since UTC month start.” Sessions created during trial in that same calendar month **still count** toward the monthly cap.

**Example:** User signs up Jan 5, uses 8 sessions Jan 5–11 (trial, unlimited). Trial ends Jan 12. Monthly limit for January is 5, counted from Jan 1 — they already have 8 sessions and cannot start new ones until February 1.

## How limits are resolved

Limits are **not** stored as fixed caps on the subscription row at signup. They are computed at request time by `resolveEffectiveLimits()` in `src/utils/effectiveLimits.ts`, called via `StyleAnalysisService.getEffectiveLimits()`.

Resolution order (Free tier):

1. **Tier** — Core → all limits `-1`
2. **Trial vs post-trial** — based on `user.created_at` and `trial_days`
3. **`user_limits` overrides** — per-user or invite-code rows in `user_limits`
4. **Env defaults** — `FREE_TIER_*` vars

Legacy note: `user_limits.session_count_limit` is treated as `monthly_session_limit` when `monthly_session_limit` is null.

## Where limits are enforced

| Action | Location | Error |
|--------|----------|-------|
| Create session | `StyleAnalysisService.createSession()` | `FREE_LIMIT_REACHED: Session limit reached…` → HTTP 403 |
| Add message | `StyleAnalysisService.addMessageToSession()` | `FREE_LIMIT_REACHED: Maximum messages…` or `Maximum images…` → HTTP 403 |

Session counts use `StyleAnalysisDB.countSessionsSince(userId, periodStart)`. Soft-deleted sessions are **included** so deleting sessions cannot bypass quotas.

Routes:

- `POST /style-analysis/sessions`
- `POST /style-analysis/sessions/:sessionId/messages`

## Client-facing API

### Get subscription + live usage

`GET /subscriptions/:userId` returns the subscription row plus computed fields:

```json
{
  "tier": "free",
  "has_reached_limit": 0,
  "limits": {
    "session_count_limit": 5,
    "message_per_session_limit": 20,
    "image_per_session_limit": 10
  },
  "in_trial": false,
  "trial_ends_at": 1736121600000,
  "period_start": 1735689600000,
  "session_usage": 3
}
```

- `limits.session_count_limit` — effective cap for the current period (`-1` = unlimited)
- `period_start` — start of the counting window (signup time during trial, UTC month start after)
- `session_usage` — sessions created since `period_start`

### `has_reached_limit` vs enforcement

`subscriptions.has_reached_limit` is a **cached UI flag** synced in the background after session creation. It drives upgrade banners in the mobile app and Supabase Realtime events (`user-limits:{userId}` / `limit_updated`).

**Hard enforcement** always re-checks limits at request time; the flag alone does not gate API access.

## Overrides

### Invite codes

If `POST /users` includes a valid `inviteCode`, limit fields from the invite are copied into `user_limits` at signup (`src/routes/users/handlers/createUserHandler.ts`).

### Admin per-user limits

`POST /users/limits` (admin API key) upserts `user_limits` for a user. Any non-null field overrides the corresponding env default.

### Admin reset (support)

`POST /subscriptions/reset` (admin API key) deletes the user's most recent session and sets `has_reached_limit = 0`. This is a support escape hatch; it does not change tier or override rows.

## Related code

| File | Role |
|------|------|
| `src/utils/effectiveLimits.ts` | Limit resolution (source of truth) |
| `src/services/style_analysis.svc.ts` | Enforcement and `has_reached_limit` sync |
| `src/db/users.ts` | Free subscription creation on signup |
| `src/db/style_analysis.ts` | `countSessionsSince()` for quota counting |
| `test/effectiveLimits.spec.ts` | Executable examples of trial/monthly behavior |

See also the `documented free-tier scenarios` describe block in that test file for product-level examples mirrored from this doc.
