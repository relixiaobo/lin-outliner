---
status: draft
priority: P1
owner: relixiaobo
created: 2026-05-21
updated: 2026-05-25
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
either follows an L0 hit (already has the messageId) or precedes an L2
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

But we keep what file tools do well — **internally we drive ripgrep against
the existing search index** to inherit its quality (fuzzy, regex,
case-insensitive, CJK) without re-implementing search.

## Goal

- Single tool, two modes. Search returns hits with anchors; read returns
  the exchange around an anchor.
- Always-on active-branch filtering. Never return content the user has
  edited away.
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
  // Search mode — pass `query`.
  query?: string;
  after?: string;                     // ISO 8601, inclusive
  before?: string;                    // ISO 8601, inclusive
  sessionIds?: string[];              // narrow to specific sessions
  limit?: number;                     // default 10, max 20
  includeCurrentSession?: boolean;    // default false

  // Read mode — pass `messageId`.
  messageId?: string;
  beforeContext?: number;             // default 1, max 5
  afterContext?: number;              // default 4, max 20
  maxChars?: number;                  // default 2000, max 8000
}
```

Mode is inferred from parameter presence:

| Input | Mode |
| --- | --- |
| `query` present, `messageId` absent | `search` |
| `messageId` present, `query` absent | `read` |
| Both present | `error: AMBIGUOUS_MODE` |
| Neither present | `error: MISSING_QUERY_OR_MESSAGE_ID` |

`query` is a free-text string passed verbatim to ripgrep (`-i` case-
insensitive, fixed-string by default, `-F`). Regex is opt-in via a future
`regex: true` flag.

### Result

A discriminated union with `mode` discriminator, including error mode so the
model can self-correct without raising an exception:

```ts
type PastChatsResult =
  | PastChatsSearchResult
  | PastChatsReadResult
  | PastChatsErrorResult;

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
Recall content from past Lin agent conversations. Call this BEFORE saying
you don't remember something.

When to call:
- User says "last time", "before", "previously", "you said", "remember",
  "we discussed", "I told you" — and the reference is NOT to something
  earlier in this same conversation.
- User references a prior decision or preference you don't have in
  current context.
- User asks "have we ever discussed X".

Two modes (chosen by parameters):

SEARCH — pass `query` plus optional `after`/`before`/`sessionIds`/`limit`.
  Returns hits across past sessions with [m_xxx] anchors.

READ — pass `messageId` from a search hit, plus optional `beforeContext`/
  `afterContext`/`maxChars`. Returns the conversation around that message.

Typical flow: SEARCH to find relevant messages, then READ the most
relevant hit for full context. Do NOT summarize from search snippets
alone — snippets are for navigation, not citation.

Important: the user does NOT see your tool output. You must restate any
recalled facts in your reply. You may use [m_xxx] anchors when referring
back to specific moments.

After compaction of the current session, pass `includeCurrentSession: true`
to recall earlier turns that are no longer in your working context.
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
│   • search(): index lookup → ripgrep → semantic filter     │
│   • read(): replay → active path → window assembly         │
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

1. Load search-index.json (already in-memory after first read).
2. Filter by `sessionIds`/`after`/`before` over `AgentEventSearchIndexEntry`.
3. Pipe candidate `normalizedText` strings to ripgrep via stdin:
   `rg -i -F --json --max-count=1 <query>`. Capture matched entries.
4. For each session with hits, compute active path
   (cached by `(sessionId, latestEventId)`).
5. Drop hits whose `messageId` is not on the session's active path.
6. Drop hits from current session unless `includeCurrentSession`.
7. Sort by `updatedAt` desc, clamp to `limit`, build snippets (200 chars
   centered on first match, `<mark>` around query terms).

Why ripgrep: file_grep already depends on it. We get fuzzy-tolerant fixed-
string match, case-insensitive search, CJK handling, and regex (when we
opt in) without bundling a JS search library or maintaining our own
normalizer beyond what the index already stores.

### Read path

1. Resolve `messageId` → `sessionId` via search-index (O(1) lookup).
2. If session is current and `includeCurrentSession` is not requested
   → `SESSION_IS_CURRENT`.
3. If session is deleted → `SESSION_NOT_FOUND` (no leak of existence
   beyond search hits the caller already saw).
4. `eventStore.replay(sessionId)` → state.
5. Compute active path from `selectedLeafMessageId`. If `messageId` is not
   on active path → `NOT_ON_ACTIVE_BRANCH` with `nearbyMessageIds` =
   active-path messages within ±10 of the anchor's position-in-path.
6. Take `beforeContext` user-role messages before the anchor and
   `afterContext` messages after (any role, until next user message that
   pushes us past `afterContext`).
7. For each message: if it's a tool call/result, use the persisted
   `outputSummary` from the payload (already stored). Otherwise read text
   from `content[]`.
8. Concatenate and clamp at `maxChars`. Set `outputTruncated` true if
   clipped. Per-message `messageTruncated` if a single message was clipped.

### Active path computation

```ts
function activePath(state: AgentEventReplayState): Set<string> {
  const ids = new Set<string>();
  let cursor = state.selectedLeafMessageId;
  while (cursor) {
    ids.add(cursor);
    cursor = state.messages[cursor]?.parentMessageId ?? null;
  }
  return ids;
}
```

Cached per process keyed by `(sessionId, state.latestEventId)`. Cache
invalidates implicitly when a new event lands (latestEventId changes).

### Current-session injection

The tool wrapper receives `currentSessionId` from the agent runtime call
context — it is **not** a parameter the model can supply. The model has no
way to spoof the current session and bypass the exclusion.

## Visibility & Safety

| Rule | Strength | Where |
| --- | --- | --- |
| Exclude deleted sessions | Hard | search + read |
| Exclude current session | Soft (override `includeCurrentSession`) | search |
| Only active branch | Hard (v1) | search + read |
| No exposure of session existence beyond search hits | Hard | read returns `SESSION_NOT_FOUND` for unknown IDs without distinguishing "never existed" vs "deleted" |

All enforcement lives in `AgentPastChatsService`. The tool wrapper does
only parameter validation and result formatting.

## Limits

| Limit | Default | Max | Behavior |
| --- | ---: | ---: | --- |
| search `limit` | 10 | 20 | silently clamp |
| search snippet chars | 200 | 200 | not configurable |
| read `beforeContext` | 1 | 5 | silently clamp |
| read `afterContext` | 4 | 20 | silently clamp |
| read `maxChars` | 2000 | 8000 | silently clamp |
| tool output total chars | — | 16000 | hard cap; signal truncation |

Silently clamp = no error; values coerced into range. The tool result
records the effective values when relevant.

## Model-Facing Output (the `content[0].text` Markdown)

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

Next: call past_chats(messageId=<one of these>) for full context.
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

— Truncated at 2000/4200 chars. Call past_chats(messageId=m_abc123, maxChars=6000).
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

## Implementation Map

| Day | Work |
| --: | --- |
| 1 | `src/main/agentPastChats.ts` service skeleton: search (no ripgrep yet, token-AND), read with active-path filter, error shapes. Tests for active-path logic. |
| 2 | Wire ripgrep: spawn process, stdin pipe, JSON output parsing. Add unit tests for fuzzy and CJK queries. |
| 3 | `src/main/agentPastChatsTool.ts` wrapper: param validation, mode inference, currentSessionId injection from runtime context, Markdown formatter. |
| 4 | Index normalization upgrade: `normalizeIndexText` adds NFC + diacritic stripping + CJK char split. Schema bump search-index version to force one-time rebuild. |
| 5 | Tool registration in `agentTools.ts`. System-prompt nudges (none needed if tool description is sufficient — verify with deterministic E2E). |
| 6 | E2E with mock LLM exercising "user references prior" → search → read → reply. Add to existing agent test suite. |
| 7 | Doc updates: remove old sketch from `agent-tool-design.md`; flip this plan's `status` to `in-progress`. |

Total: ~5–7 dev days for a contractually complete v1.

## Tests

Core service tests (in `tests/core/agentPastChats.test.ts`):

- Search returns active-branch messages only when sibling branches exist.
- Search excludes current session unless `includeCurrentSession: true`.
- Search excludes deleted sessions.
- Search clamps `limit > 20` to 20 silently.
- Search hits are sorted by `updatedAt` desc.
- Search with `after`/`before` filters correctly inclusive of bounds.
- Read returns NOT_ON_ACTIVE_BRANCH with nearbyMessageIds when target is
  on a sibling branch.
- Read returns SESSION_IS_CURRENT for the current session unless
  `includeCurrentSession`.
- Read clamps `beforeContext > 5` and `afterContext > 20` silently.
- Read includes tool-call messages with summarized output, not raw payload.
- Read returns SESSION_NOT_FOUND for unknown message IDs without
  distinguishing "never existed" from "deleted".

Tool wrapper tests:

- AMBIGUOUS_MODE when both `query` and `messageId` are present.
- MISSING_QUERY_OR_MESSAGE_ID when neither is present.
- Markdown formatter produces stable anchor format `[m_xxx]`.
- Markdown formatter caps total output at 16000 chars.
- Snippet `<mark>` highlighting covers all query terms.

E2E (`tests/e2e/agent-past-chats.spec.ts`):

- Mock LLM that, on seeing "last time", calls `past_chats(query=...)`
  → receives hits → calls `past_chats(messageId=...)` → cites the
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
- **ripgrep, not fuzzysort, not embeddings.** ripgrep is already in the
  process tree for `file_grep`, gives fuzzy-tolerant fixed-string match
  and CJK out of the box, no JS dependency. Embeddings deferred until a
  real recall failure surfaces in usage.
- **`messageId` not `messageTs`.** Lin has message branching; messageId
  is stable across branch operations, timestamps are not.
- **`<mark>` highlighting in snippets.** Models read structured Markdown
  efficiently; the `<mark>` tag is a strong signal of "this matched".
- **`[m_xxx]` anchors in Markdown.** A short stable identifier the model
  can quote in tool calls and replies without needing to remember
  surrounding context.
- **No transcript materialization to disk.** Branch filtering is a
  semantic operation grep cannot express; materializing would still
  require a service layer for filtering, so the file-system layer adds
  cost without saving design.
- **`includeCurrentSession` exists.** After compaction, the model may
  legitimately need to read original content from its own session.

## Future Work (post v1)

- **Regex search**: `regex: true` flag on search, passed through to ripgrep
  without `-F`.
- **Hit ranking**: today sort by `updatedAt`. Later score by query-term
  density, role match (user vs assistant), and recency-weighted blend.
- **Citation UI**: render `[m_xxx]` anchors in assistant messages as
  clickable jumps to the source session and message.
- **Embedding rerank**: only invoked when ripgrep returns fewer than N
  hits. Cached per query. Out of scope for v1.
- **Cross-branch read**: `branch: 'all'` parameter on read. Currently
  every read is active-branch-only; no real workflow has surfaced for
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
