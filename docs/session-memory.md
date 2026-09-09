# Session memory

How the style-analysis assistant remembers facts **within a single session**, and how that differs from conversation history and cross-session user memory.

Session memory is a compact, tagged summary of this chat (occasion, constraints, prefs, outfit images). It is **not** the raw message log. On each stream, those tags are re-fetched and injected into the system prompt so the model still has the important facts even when only recent messages are sent.

## The three context layers

When a session is streamed (`generateStyleAdviceStream`), the LLM sees messages in this order:

1. **System prompt** + `[SESSION MEMORY]` + `[USER MEMORY]`
2. **Session image context** (tagged outfit photos, latest marked `[LATEST]`)
3. **Conversation history** (actual user/assistant turns, sliced by `contextMode`)

| Layer | Scope | Source | Survives a new session? |
|-------|--------|--------|-------------------------|
| Conversation history | This session | `style_analysis_entries` | No (and may be truncated to recent turns) |
| **Session memory** | This session | `style_analysis_entry_tags` | No |
| User memory | This user | VoltMem sidecar | Yes (text prefs/constraints/occasions only) |

If session memory and user memory disagree, the style prompt tells the model to **prefer session memory**.

Outfit **images** are never written to VoltMem. The model is told it has no persistent memory of past outfit photos across sessions.

## How facts get into session memory

Classification runs in the background after messages are saved (`ctx.waitUntil`), so it does not block create/add/stream.

1. User creates a session or adds a message.
2. `ClassificationService.tagEntryInBackground` classifies the message:
   - **Hand-rolled rules** first (image-only uploads → primary/alt outfit; replies to “What’s the occasion…” → occasion).
   - Otherwise an LLM classifier extracts tags (`CLASSIFICATION_SYSTEM_PROMPT`).
3. Tags with a `summary` are stored on the message in D1 (`addEntryTags`).
4. Text tags are also written through to VoltMem (fail-open). See [Write-through to user memory](#write-through-to-user-memory).

Because tagging is async, the **next** stream after a new message may not yet include that message’s tags.

## Tag types

Stored as `session_state:*` on `style_analysis_entry_tags`. Each payload must include a `summary` (1–2 sentences). Rows without a parseable `summary` are skipped at read time.

| Tag | Meaning | In session memory | Written to VoltMem |
|-----|---------|-------------------|--------------------|
| `session_state:occasion` | Event / situation | Text line | Yes |
| `session_state:constraint` | Hard limits (weather, budget, dress code) | Text line | Yes |
| `session_state:user_prefs` | Stated style preferences | Text line | Yes |
| `session_state:primary_outfit_image` | Main outfit photo(s) for this session | Image message | No |
| `session_state:alt_outfit_image` | Extra / iteration photos | Image message | No |
| `session_state:final_verdict` | Reserved in schema | — | No |

Primary vs alt is enforced from D1 (`hasPrimaryOutfitTag`), not left to the classifier. Image tags get R2 keys injected from the original message.

## How session memory is injected

On stream (`StyleAnalysisService.generateStyleAdviceStream`):

1. `getSessionMemory(sessionId)` loads all tags for the session, oldest first.
2. **Text tags** (no images) become a `[SESSION MEMORY]` block on the system prompt:
   ```
   [SESSION MEMORY]
   - Occasion: User needs an outfit for a summer wedding.
   - Constraint: Outfit must be breathable and cool.
   ```
3. **Image tags** become extra user messages before conversation history. The most recent image item is prefixed with `[LATEST]`.
4. Conversation history is appended separately (`contextMode`: `recent` default 10, `all`, or `last`). Session memory is always the full tagged set for the session, not sliced with history.

## Write-through to user memory

After tags are saved, `writeThroughVoltMem` copies `occasion`, `constraint`, and `user_prefs` summaries into VoltMem under the D1 `users.id`.

On the next stream (any session), VoltMem is searched (`searchPrefs`) and hits are appended as `[USER MEMORY]`. If VoltMem is unconfigured or errors, the stream still runs: factory returns `null` when `VOLTMEM_URL` / `VOLTMEM_API_KEY` are missing, and search/write failures return empty/null.

## Key files

| File | Role |
|------|------|
| `src/services/classification.svc.ts` | Extract tags (rules + LLM), persist, VoltMem write-through |
| `src/db/style_analysis.ts` | `addEntryTags`, `getSessionMemory`, `hasPrimaryOutfitTag` |
| `src/services/style_analysis.svc.ts` | Build `[SESSION MEMORY]` / `[USER MEMORY]` and stream |
| `src/services/voltmem.svc.ts` | Cross-session sidecar (fail-open) |
| `src/llm/prompts/classification.ts` | Classifier tag schema |
| `src/llm/prompts/style_analysis.ts` | How the assistant should use the two memory blocks |
| `db/schema.sql` | `style_analysis_entry_tags` |
