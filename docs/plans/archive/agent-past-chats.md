---
status: done
priority: P1
owner: relixiaobo
created: 2026-05-21
updated: 2026-06-03
supersedes: agent-tool-design.md § "past_chats" (lines 1984-2021 of the historical sketch)
---

# Agent `past_chats` Tool

The agent's mechanism for recalling content from older Lin agent
conversations. One read-only tool, designed for the agent's true access
pattern — find by topic, read with context — not for chat-drawer browsing.

This is **agent infrastructure**. Get it right at v1; the cost of redesigning
later is paid in every conversation.

## Why this shape (and not the obvious one)

Three reference implementations exist (nodex, sider-agent, lin-agent) and
they all use a 3-level progressive disclosure (list sessions → list messages
in a session → read one message's exchange). That shape comes from the
browser-extension chat drawer UI: a human clicks through sessions, then
opens one to see messages. **An agent does not navigate that way.** It
searches by topic, then reads the matching exchange with surrounding
context.

The middle layer ("list messages in a session") exists only to support a
human's chronological scan. The agent never benefits from it: every L1 call
either follows an L0 hit (already has the `message_id`) or precedes an L2
(could go direct from search). Dropping L1 gives us a cleaner contract with
no behavior loss.

We also considered exposing chat history as files for `file_grep`/`file_read`
to consume. Rejected:

- Markdown structure (`**User**`, `[m_xxx]`, timestamps) creates false
  positives for grep matches.
- Branch filtering (active path) is a semantic operation `grep` cannot
  express; we would still need a service layer.
- Current-session exclusion via filename conventions is fragile.
- File paths leak into agent replies as ugly citations.

For v1, search semantics stay inside the event-store service layer. We use the
existing normalized search index with token-AND matching, then apply semantic
visibility filtering. Ripgrep remains a possible future helper for snippet
highlighting or regex mode, but it does not define v1 recall semantics.

## Goal

- Single tool, three modes. Recent returns user-message anchors for overview;
  search returns keyword hits; read returns the exchange around an anchor.
- Always-on visible-transcript filtering. Never return sibling-branch
  content the user has edited away, while still allowing compacted originals
  that remain visible through transcript expansion.
- Self-correcting errors. Wrong message IDs and missing sessions return a
  structured result the model can act on without retry.
- Bounded output. Hard caps on every dimension, always silently clamped.
- Tool description that overrides the model's default "I don't remember"
  disposition.

## Non-goals

- Memory facts, long-term summaries auto-injected into every turn.
- Channel/conversation-grouping abstractions. Lin uses sessions; that's
  enough.
- Cross-session reference graph, topic clustering, related-session
  suggestions. Add only if real workflows need them.
- Multi-workspace scoping. Lin has no workspace concept on sessions yet;
  schema does not pre-bake one.
- Materializing transcripts to disk.
- UI changes in this plan. Citation rendering is a follow-up.

## Tool Contract

### Parameters

```ts
interface PastChatsParams {
  // Recent overview mode — pass `recent: true`.
  recent?: boolean;

  // Search mode — pass `query`.
  query?: string;
  after?: string;                     // ISO 8601, inclusive
  before?: string;                    // ISO 8601, inclusive
  session_ids?: string[];             // narrow to specific sessions
  limit?: number;                     // search default 10/max 20; recent default 20/max 50
  include_current_session?: boolean;  // default false
  max_message_chars?: number;         // recent default 360, max 1200

  // Read mode — pass `message_id`.
  message_id?: string;
  before_context?: number;            // default 1, max 5
  after_context?: number;             // default 4, max 20
  max_chars?: number;                 // default 2000, max 8000
}
```

Mode is inferred from parameter presence:

| Input | Mode |
| --- | --- |
| `recent: true`, no `query` or `message_id` | `recent` |
| `query` present, no `recent` or `message_id` | `search` |
| `message_id` present, no `recent` or `query` | `read` |
| More than one mode selector | `error: AMBIGUOUS_MODE` |
| No mode selector | `error: MISSING_QUERY_OR_MESSAGE_ID` |

`query` is a free-text string normalized the same way as the existing
event-store search index. v1 uses token-AND matching over `normalizedText`.
Regex is opt-in via a future `regex: true` flag.

### Result

The tool returns the same `ToolEnvelope` shape as the file, web, and node
tools. `content[0].text` is the compact model-visible JSON envelope;
`details.data` carries the complete TypeScript result below for runtime/UI
consumers. Public tool parameters and the compact model-visible summary use
snake_case; the internal TypeScript result types stay camelCase.

A discriminated union with `mode` discriminator, including error mode so the
model can self-correct without raising an exception:

```ts
type PastChatsResult =
  | PastChatsRecentResult
  | PastChatsSearchResult
  | PastChatsReadResult
  | PastChatsErrorResult;

interface PastChatsRecentResult {
  mode: 'recent';
  items: Array<{
    messageId: string;
    sessionId: string;
    sessionTitle: string | null;
    createdAt: string;                // ISO
    text: string;                     // user message text with system reminders stripped
    totalChars: number;
    textTruncated: boolean;
    hasAttachments: boolean;
  }>;
  totalItems: number;                 // before limit truncation
  truncated: boolean;                 // totalItems > limit
}

interface PastChatsSearchResult {
  mode: 'search';
  hits: Array<{
    messageId: string;
    sessionId: string;
    sessionTitle: string | null;
    role: 'user' | 'assistant' | 'toolResult';
    createdAt: string;                // ISO
    snippet: string;                  // 200 chars, query terms surrounded by <mark>…</mark>
  }>;
  totalHits: number;                  // before limit truncation
  truncated: boolean;                 // totalHits > limit
}

interface PastChatsReadResult {
  mode: 'read';
  session: { id: string; title: string | null; createdAt: string; updatedAt: string };
  anchorMessageId: string;
  messages: Array<{
    messageId: string;
    role: 'user' | 'assistant' | 'toolResult';
    createdAt: string;                // ISO
    text: string;                     // tool calls/results already summarized
    toolName?: string;
    isError?: boolean;
    messageTruncated?: boolean;       // per-message truncation
  }>;
  totalChars: number;                 // for the full assembled output
  outputTruncated: boolean;
}

interface PastChatsErrorResult {
  mode: 'error';
  code:
    | 'AMBIGUOUS_MODE'
    | 'MISSING_QUERY_OR_MESSAGE_ID'
    | 'SESSION_NOT_FOUND'
    | 'NOT_ON_ACTIVE_BRANCH'
    | 'SESSION_IS_CURRENT';
  message: string;
  nearbyMessageIds?: string[];        // for NOT_ON_ACTIVE_BRANCH
}
```

### Tool description (model-facing, verbatim)

This text ships in the tool registration. It is the highest-leverage
artifact in this design — it converts the model's default "I don't remember"
into proactive recall. Do not soften it.

```text
Recall content from past Lin agent conversations. Call this BEFORE saying you don't remember something.

When to call:
- User says "last time", "before", "previously", "you said", "remember", "we discussed", "I told you" - and the reference is NOT to something earlier in this same conversation.
- User references a prior decision or preference you don't have in current context.
- User asks "have we ever discussed X".

Three modes (chosen by parameters):

RECENT - pass recent: true plus optional after/before/session_ids/limit/max_message_chars.
  Returns recent visible user messages only, with message_id anchors. System reminders are stripped. Use this when the user asks what you discussed before but gives no concrete keywords.

SEARCH - pass query plus optional after/before/session_ids/limit.
  Returns hits across past sessions with [message_id] anchors.
  Search is keyword recall, not a topic inventory. Do not search generic meta phrases like "conversation history topics discussed"; use concrete words, names, decisions, file paths, or concepts from the user's request.

READ - pass message_id from a search hit, plus optional before_context/after_context/max_chars.
  Returns the conversation around that message.

Typical flow: SEARCH to find relevant messages, then READ the most relevant hit for full context. Do NOT summarize from search snippets alone - snippets are for navigation, not citation.

Important: the user does NOT see your tool output. You must restate any recalled facts in your reply. You may use message_id anchors when referring back to specific moments.

After compaction of the current session, pass include_current_session: true to recall earlier turns that are no longer in your working context.
```

## Internal Design

```
┌────────────────────────────────────────────────────────────┐
│ Tool wrapper (src/main/agentPastChatsTool.ts)              │
│   • param validation, mode inference                       │
│   • Markdown formatting of result                          │
│   • injects currentSessionId from runtime context          │
└────────────────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────┐
│ AgentPastChatsService (src/main/agentPastChats.ts)         │
│   • search(): index lookup → token-AND → semantic filter   │
│   • read(): replay → visible transcript → window assembly  │
│   • single source of visibility rules                      │
└────────────────────────────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────────┐
│ AgentEventStore (existing, unchanged)                      │
│   • search-index.json, session-index.json                  │
│   • replay(sessionId) with checkpoint fast path            │
└────────────────────────────────────────────────────────────┘
```

### Search path

1. Load `search-index.json` through `AgentEventStore`.
2. Filter by `session_ids`/`after`/`before` over `AgentEventSearchIndexEntry`.
3. Match normalized query terms against `normalizedText` with token-AND
   semantics.
4. For each session with hits, compute the visible transcript message set
   (cached by `(sessionId, latestEventId)`).
5. Drop hits whose message id is not visible in that transcript set. For user
   messages, re-read visible content and strip `<system-reminder>` blocks
   before snippet generation.
6. Drop hits from current session unless `include_current_session`.
7. Sort by session recency and message `updatedAt` desc, clamp to `limit`, build snippets (200 chars
   centered on first match, `<mark>` around query terms).

Why not ripgrep for v1 semantics: `rg -F` is fixed-string matching, not fuzzy,
and `--max-count=1` over stdin stops at the first matching input stream line.
That is narrower than Lin's existing token-AND search. Keeping recall semantics
inside the service avoids a second query language and makes branch/compaction
filtering explicit.

### Recent path

1. Load `userMessages` from `search-index.json`.
2. Filter by `session_ids`/`after`/`before` and current-session exclusion.
3. Replay only candidate sessions and keep messages on the visible transcript.
4. Drop compaction boundary/system-generated user rows and strip
   `<system-reminder>...</system-reminder>` from user text.
5. Clamp each item at `max_message_chars`, include `messageId`, and sort by
   user message `createdAt` desc.

Recent output is navigation, not evidence. The model should call
`past_chats(message_id=...)` before relying on details.

### Read path

1. Resolve `message_id` → `sessionId` via search-index (O(1) lookup).
2. If session is current and `include_current_session` is not requested
   → `SESSION_IS_CURRENT`.
3. If session is deleted → `SESSION_NOT_FOUND` (no leak of existence
   beyond search hits the caller already saw).
4. `eventStore.replay(sessionId)` → state.
5. Compute the visible transcript path. If `message_id` is not visible
   → `NOT_ON_ACTIVE_BRANCH` with `nearbyMessageIds` = nearby visible messages.
6. Take `before_context` user-role messages before the anchor and
   `after_context` messages after (any role, until next user message that
   pushes us past `after_context`).
7. For each message: if it's a tool result, use the replayed
   `outputSummary` stored on `AgentEventMessageRecord`. Otherwise read text
   from `content[]`.
8. Concatenate and clamp at `max_chars`. Set `outputTruncated` true if
   clipped. Per-message `messageTruncated` if a single message was clipped.

### Visible transcript computation

```ts
getAgentEventVisibleTranscript(state): Array<{
  message: AgentEventMessageRecord;
  archived: boolean;
}>
```

This helper lives in `src/core/agentEventLog.ts` and is shared by the renderer
and `past_chats`. It follows the active branch, expands compaction boundaries
back to the compacted-through message, and still excludes sibling branches
that were edited away. Cached per process keyed by `(sessionId,
state.latestEventId)`. Cache invalidates implicitly when a new event lands
(`latestEventId` changes).

### Current-session injection

The tool wrapper receives `currentSessionId` from the agent runtime call
context — it is **not** a parameter the model can supply. The model has no
way to spoof the current session and bypass the exclusion.

## Visibility & Safety

| Rule | Strength | Where |
| --- | --- | --- |
| Exclude deleted sessions | Hard | recent + search + read |
| Exclude current session | Soft (override `include_current_session`) | recent + search + read |
| Only visible transcript branch | Hard (v1) | recent + search + read |
| No exposure of session existence beyond search hits | Hard | read returns `SESSION_NOT_FOUND` for unknown IDs without distinguishing "never existed" vs "deleted" |

All enforcement lives in `AgentPastChatsService`. The tool wrapper does
only parameter validation and result formatting.

## Storage Discipline

`past_chats` does not introduce another chat-history store.

- No transcript Markdown files.
- No mutable chat snapshot JSON.
- No expansion of large payloads into recent/search/read output.
- Search and session indexes remain rebuildable derived caches.
- Checkpoints remain bounded derived caches; the checkpoint version is bumped
  when replay state gains fields such as `outputSummary`.

## Limits

| Limit | Default | Max | Behavior |
| --- | ---: | ---: | --- |
| recent `limit` | 20 | 50 | silently clamp |
| recent `max_message_chars` | 360 | 1200 | silently clamp |
| search `limit` | 10 | 20 | silently clamp |
| search snippet chars | 200 | 200 | not configurable |
| read `before_context` | 1 | 5 | silently clamp |
| read `after_context` | 4 | 20 | silently clamp |
| read `max_chars` | 2000 | 8000 | silently clamp |
| tool output total chars | — | 16000 | hard cap; signal truncation |

Silently clamp = no error; values coerced into range. The tool result
records the effective values when relevant.

## Model-Facing Output

`content[0].text` is standard JSON:

```json
{
  "ok": true,
  "tool": "past_chats",
  "status": "success",
  "data": {
    "mode": "search",
    "total_hits": 7,
    "returned_hits": 7,
    "truncated": false,
    "message_ids": ["m_abc123", "m_def456"]
  },
  "instructions": "Call past_chats with message_id from a hit to read full context before relying on it."
}
```

The readable transcript/search text is appended as `content[1].text`.

### Recent example

```markdown
Found 3 recent user messages:

[m_abc123] s_x9q2 - "Agent past chats" - 2026-05-25 08:12
> 用户发送的内容，通常更能代表，并且也更精简...
> [truncated 360/912 chars; call past_chats with message_id for full context]

[m_def456] s_b3k1 - "Tool API polish" - 2026-05-24 17:41
> 好的，把工具 API 风格打磨到更统一

Next: call past_chats with message_id from one item for full context.
```

### Search example

```markdown
Found 7 hits for "OAuth":

[m_abc123] s_x9q2 · "OAuth setup discussion" · 2026-03-12 14:30 · User
> Should we use <mark>OAuth</mark> 1 or 2?

[m_def456] s_x9q2 · "OAuth setup discussion" · 2026-03-12 14:31 · Assistant
> <mark>OAuth</mark> 2 — easier integration with modern providers…

[m_pqr890] s_b3k1 · "API rewrite plan" · 2026-04-02 09:15 · User
> Decided to drop <mark>OAuth</mark> in favor of API keys.

…4 more hits. Pass limit=20 to see more or refine query.

Next: call past_chats(message_id=<one of these>) for full context.
```

### Read example

```markdown
# "OAuth setup discussion" · s_x9q2
2026-03-12 14:28–14:45 · 7 messages

[m_xyz000] User · 14:28
> I'm building auth for the new dashboard.

[m_abc123] User · 14:30  ← anchor
> Should we use OAuth 1 or 2?

[m_def456] Assistant · 14:31
OAuth 2 — easier integration with modern providers, better RFC clarity…
[tool: web_search · 12 hits · "OAuth 2 vs 1 comparison…"]

[m_ghi789] User · 14:33
> What library do you recommend?

[m_jkl012] Assistant · 14:34
For Node: `oidc-client-ts`. For Python: `authlib`…

— Truncated at 2000/4200 chars. Call past_chats(message_id=m_abc123, max_chars=6000).
```

### Error example

```markdown
Error: NOT_ON_ACTIVE_BRANCH

The message m_xxx was edited away or is on a non-active branch. Nearby
messages on the active branch:

- m_abc123 (User, 2026-03-12 14:30)
- m_def456 (Assistant, 2026-03-12 14:31)
- m_ghi789 (User, 2026-03-12 14:33)
```

The structured `mode: 'error'` result is always also returned so runtime
code can render specifically.

### Empty search example

```markdown
No matching past chat messages found for this query.
This does not prove there is no chat history or that history was not saved. Retry with concrete names, decisions, file paths, or exact words from the user request. If the user gave no concrete terms, ask for a keyword instead of guessing.
```

## Implementation Map

| Day | Work |
| --: | --- |
| 1 | Shared `getAgentEventVisibleTranscript()` helper plus `outputSummary` on replayed tool-result messages. |
| 2 | `src/main/agentPastChats.ts`: token-AND search, visible transcript filter, read windows, structured errors. |
| 3 | `src/main/agentPastChatsTool.ts`: param validation, mode inference, currentSessionId injection, Markdown formatter. |
| 4 | Tool registration in `agentTools.ts` and runtime current-session wiring. |
| 5 | Core tests for branch filtering, current-session exclusion, compaction recall, summarized tool output, and wrapper errors. |
| 6 | E2E with mock LLM exercising "user references prior" → search → read → reply. |
| 7 | Optional search refinements: better CJK tokenization, diacritic stripping, regex/ripgrep mode, or relevance ranking if usage shows recall failures. |

Total: ~5–7 dev days for a contractually complete v1.

## Tests

Core service tests (in `tests/core/agentPastChats.test.ts`):

- Recent returns visible user-message anchors for overview navigation.
- Recent excludes current session unless `include_current_session: true`.
- Recent strips system reminders and truncates long user messages.
- Search returns visible-transcript messages only when sibling branches exist.
- Search excludes current session unless `include_current_session: true`.
- Search excludes deleted sessions.
- Search clamps `limit > 20` to 20 silently.
- Search hits are sorted by `updatedAt` desc.
- Search with `after`/`before` filters correctly inclusive of bounds.
- Read returns NOT_ON_ACTIVE_BRANCH with nearbyMessageIds when target is
  on a sibling branch.
- Read returns SESSION_IS_CURRENT for the current session unless
  `include_current_session`.
- Read clamps `before_context > 5` and `after_context > 20` silently.
- Read includes tool-call messages with summarized output, not raw payload.
- Read returns SESSION_NOT_FOUND for unknown message IDs without
  distinguishing "never existed" from "deleted".

Tool wrapper tests:

- AMBIGUOUS_MODE when both `query` and `message_id` are present.
- MISSING_QUERY_OR_MESSAGE_ID when neither is present.
- Recent model-visible output uses snake_case fields and points follow-up to
  `message_id`.
- Empty search output instructs the model not to claim this is the first
  conversation or that history was not saved.
- Markdown formatter produces stable anchor format `[m_xxx]`.
- Markdown formatter caps total output at 16000 chars.
- Snippet `<mark>` highlighting covers all query terms.

E2E (`tests/e2e/agent-past-chats.spec.ts`):

- Mock LLM that, on seeing "last time", calls `past_chats(query=...)`
  → receives hits → calls `past_chats(message_id=...)` → cites the
  recalled fact in its final reply. Assert exact tool call sequence.

## Decision Log

Decisions intentionally made differently from existing nodex / sider /
lin-agent references, with rationale:

- **No L1 layer.** Removed because the agent's access pattern is
  topic-driven, not chronological-within-session. L0 → L2 is sufficient.
- **One tool, conditional params.** Same pattern as all three references,
  but with discriminated-union return so the model can read the `mode`
  field instead of inferring from result shape.
- **Errors as `mode: 'error'`, not exceptions.** Models self-correct
  better from structured errors than from thrown failures.
- **Token-AND v1, not ripgrep/fuzzysort/embeddings.** The existing search
  index already provides normalized text and predictable token-AND semantics.
  Ripgrep is deferred to optional regex/snippet support because fixed-string
  `rg` is not fuzzy and is easy to wire incorrectly over stdin. Embeddings
  are deferred until a real recall failure surfaces in usage.
- **`message_id` not `message_ts`.** Lin has message branching; message ids
  are stable across branch operations, timestamps are not.
- **`<mark>` highlighting in snippets.** Models read structured Markdown
  efficiently; the `<mark>` tag is a strong signal of "this matched".
- **`[m_xxx]` anchors in Markdown.** A short stable identifier the model
  can quote in tool calls and replies without needing to remember
  surrounding context.
- **No transcript materialization to disk.** Branch filtering is a
  semantic operation grep cannot express; materializing would still
  require a service layer for filtering, so the file-system layer adds
  cost without saving design.
- **`include_current_session` exists.** After compaction, the model may
  legitimately need to read original content from its own session.

## Future Work (post v1)

- **Regex search**: `regex: true` flag on search, passed through to ripgrep
  without `-F`.
- **Hit ranking**: today sort by `updatedAt`. Later score by query-term
  density, role match (user vs assistant), and recency-weighted blend.
- **Citation UI**: render `[m_xxx]` anchors in assistant messages as
  clickable jumps to the source session and message.
- **Embedding rerank**: only invoked when lexical search returns too few or too
  many weak hits. Cached per query. Out of scope for v1.
- **Cross-branch read**: `branch: 'all'` parameter on read. Currently every
  read is visible-transcript-only; no real workflow has surfaced for
  cross-branch recall yet.

## References

- `src/main/agentEventStore.ts` — `searchMessages`, `listSessionIndexEntries`,
  `listUserMessageIndexEntries`, `replay`. The service layer wraps these,
  does not bypass them.
- `src/core/agentEventLog.ts` — `AgentEventReplayState`, message branch
  fields (`parentMessageId`, `selectedLeafMessageId`, `childrenByParentId`).
- `docs/spec/agent-event-log-rendering.md` — durable agent architecture.
- `docs/spec/agent-tool-design.md` — public agent tool protocol. The
  historical `past_chats` sketch in that doc is superseded by this plan
  and should be removed when implementation lands.

External references (read for inspiration, not copy):

- lin-agent — best service-boundary reference; visibility rules and
  three-overload tool wrapper. Currently checked out under
  `~/Documents/Coding/lin-agent`.
- sider-agent — best progressive disclosure contract reference. Currently
  checked out under `~/Documents/Coding/sider-agent`.
- nodex — original three-level pattern. Currently checked out under
  `~/Documents/Coding/nodex`.
