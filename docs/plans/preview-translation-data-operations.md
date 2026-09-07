# Preview Translation And Data Operations

## Goal

Deliver Unit E2 of [File-First Settings](settings-control-plane.md) as **one
complete feature in one PR**: people and root Agents control a live preview's
translation, clear saved translations for its content, and inspect or clear
Tenon's preview data. Include runtime, Host/preload, UI, tools, retirement,
specification updates, and real-flow verification together.

## Non-goals

- No Settings/Configuration CLI, including read-only helpers; no universal
  settings tool, private-cache file editing, or new global Translation defaults.
- No per-preview durable cache copies, persisted preview preferences, content
  extraction tool, new translation engine, or expansion of supported formats.
- No external-browser data deletion, credential management, server-side logout,
  migration reader, full Settings-shell redesign, or other delivery unit.

## Design

### Preview Controls And Identity

The mounted preview owns its choices: target follows UI locale until explicitly
selected; model is dynamic `Follow Agent` until explicitly selected; automatic
translation starts off. Follow Agent uses the Models owner's effective
application selection, not whichever Thread an Agent names or last focuses.
Resolve it for each new request and retain the resolved snapshot for in-flight
work. Keep explicit unavailable choices visible; do not substitute another model.

One automatic-translation choice covers supported content in that preview,
including webpage captions and reflowable EPUBs. Choices survive navigation
inside the preview; leaving the preview, closing it, renderer loss, or restart
ends the lifetime. A restored pane starts with defaults. Explicit Translate /
Show original intent also survives navigation and takes precedence over
automatic evaluation until the person or Agent changes that intent. Navigation
cancels obsolete content work without forgetting the preview's choices.

Keep three identities distinct: live preview, cancellable request, and reusable
content cache. `ResourcePreviewHost` registers a host-issued opaque preview ID
against the admitted main-window sender and mounted pane lifetime. The renderer
publishes a bounded revisioned snapshot of that preview's controls, source, and
availability; this is observation, not another desired-state store. Navigation,
surface replacement, and control changes advance revision. Close unregisters;
sender destruction invalidates every owned identity. Guest webContents cannot
register previews or invoke these operations.

Proposed root domain tools are `preview_inspect` and `preview_manage`.
Inspection exposes bounded live descriptors and exact IDs/revisions, control
state, readiness, and model choices from the existing Models catalog, not page
text or credential inputs. Management supports a typed control patch, explicit
Translate / Show original, and content-cache clear. Omission of the preview ID
works only when exactly one eligible live preview exists; otherwise return
unavailable and require selection from inspection. Never infer identity from a
URL, request session ID, recent focus, or execution directory.

Use canonical object-rooted schemas, bounded output schemas, and separate
inspection/management action descriptors. Reject unknown fields and illegal
operation/argument combinations; no operation accepts arbitrary setting keys.

UI and Agent control changes use the same preview controller through narrow Host
transport. Check caller authority and expected lifetime/revision before dispatch;
the renderer checks the exact target again before applying. Acknowledge the
resulting control revision only after the controller accepts the change. A sent
message is not success: a missing acknowledgement is unknown, and a stale target
is unavailable. Provider completion and per-block failures remain separate from
control application. Re-inspect after an unknown outcome instead of blindly
replaying a toggle. Preserve block retries, bounded scheduling, reading anchors,
and existing keyboard behavior.

### Cache Scope And Clearing

Label the contextual operation **Clear cached
translations for this content**. It removes saved entries for the preview's
current resource across target languages, resolved models, and applicable page,
caption, or document variants. It does not clear navigation history's resources.
Saved content is shared across previews and reopen; it is not secretly duplicated
for each preview lifetime. Consequently, another same-source preview's later
lookup can miss the deleted shared entries. Its displayed translations and
pending translation results remain valid.

Both content clear and Data's global clear remove **saved cache only**. Neither
changes live controls, removes displayed translations, cancels provider work,
reloads previews, nor immediately retranslates. Outcomes explicitly report that
live displays were retained. This separates storage maintenance from Translate /
Show original and avoids partial disk-plus-renderer mutations. New requests can
populate fresh cache entries after clearing; clearing is not disabling caching.

`PreviewTranslationCacheStore` keeps content/configuration-based reuse. Add an
opaque source digest and content kind to its bounded manifest so content clear
and aggregate inspection include cold shards without storing URLs, paths, or
source text. Clear source identity comes from the registered current preview,
not an Agent-supplied path, URL, or arbitrary digest. An unavailable resource
identity produces unavailable, never an accidental global clear.

Use a global write generation plus a source write generation. Capture the write
ticket when `PageTranslationService` admits a request, before any model lookup,
cache lookup, retry, or provider await; validate it inside the cache write queue.
Content clear fences that source's older writes; global clear fences all older
writes. A rejected cache write must not discard a still-current preview result.
New-generation requests can cache fresh output. Bound generation metadata by
stored sources and outstanding tickets, releasing it without an ABA reuse race.

Serialize inspection, dirty flushes, clears, and records in the existing cache
owner. Remove matching hot, dirty, and cold entries together; prevent delayed
flushes, startup reconciliation, or pre-clear results from restoring them. Reuse
private atomic persistence and interrupted-clear cleanup, with content-scoped
failure handling. Report partial or failed physical deletion honestly; a new
generation alone does not prove deletion. Format changes have no legacy reader.

### Data Operations And Authority

Proposed `data_inspect` and `data_manage` root tools share a Data-owned Host
facade with human controls. Inspection returns bounded cache entry counts by
kind, logical cache bytes and limits, preview-session availability, Chromium
cache bytes when available, active guest count, and operation outcomes. Label
logical versus measured sizes; unavailable measurements are unknown, not zero.
Do not enumerate sites, cookies, URLs, source text, credentials, or private paths.

Every clear uses a cancel-default native confirmation for the same named scope
whether initiated by UI or Agent. Revalidate canonical caller lifetime, root
tool exposure, capability ceilings, global disablement, and operation-specific
blocks after interaction and immediately before effects. For content clear,
also revalidate the selected preview lifetime/revision and source. No approved
argument or Agent-authored confirmation substitutes for the native decision.
Inspection does not require destructive authority. Child callers and guest
renderers cannot obtain the facade by supplying a root or window identity.

Website-data clear targets only the host-owned preview partition. Reuse
`clearUrlPreviewSessionData` for connections, HTTP authentication, browser cache,
and site storage; flush cookies and reload existing live preview guests after
successful clearing. Explain the sign-in impact in the confirmation. Report
per-stage failure and reload outcome separately: deletion cannot be rolled back,
and a reload error cannot make completed deletion retryable. Later website
activity can create new data; this is not a guarantee of an empty live session
or revocation of remote sessions. Never touch the default/external browser
session, Agent secrets, document assets, or the translation-cache owner.

Keep progress, bounded redacted errors, and narrow invalidation events in the
owning preview or Data facade. Once effects begin, settle the admitted bounded
operation even if its caller disappears; do not claim rollback or duplicate it
because result delivery failed. Use bounded in-memory operation identities and
inspection for the running Host lifetime, not a new durable maintenance ledger.
After restart, inspect current data; do not invent a previous successful receipt.

### Human Surface, Retirement, And Files

Keep the preview's Languages popover for local controls and contextual cache
clear. Replace the global translation form in the existing Preview category
with Data-owned maintenance controls and status. Preserve its current entry;
Unit G owns final flat discovery and category-shell removal. Data owns its own
loading/error state, without aggregate Settings DTOs or broad notifications.
Model choices use the existing Models catalog, not the Settings shell's snapshot.

Remove the four global fields `translationLanguage`, `translationModel`,
`autoTranslateUrls`, and `autoTranslateEpubs` from `appPreferences`, their
WindowApplicationHost/preload bootstrap and broadcasts, renderer singletons,
Settings-only clear adapters, unused controls, and obsolete tests. Preserve
remembered root model selection. Derive the retirement sweep from repository
references. Update the configuration Skill's routing only for shipped operations.

Expected files: preview operation schemas and `src/core/urlPageTranslation.ts`;
`ResourcePreviewHost`, `PageTranslationService`, `PreviewTranslationCacheStore`,
`urlPreviewSession`, `appPreferences`, `windowApplicationHost`; preview/Data Host
facades; canonical Agent tool catalog, capabilities and factories; `desktopHost`,
preload and renderer API declarations; preview lifecycle/controller/popover and
Data UI modules; locale catalogs; corresponding core/renderer/smoke tests; the
configuration Skill and architecture, UI-behavior, tool, and permission specs.

Collision check: PR #646 overlaps `src/core/agent/tools.ts`,
`src/main/agent/capabilities/agentCapabilities.ts`, `src/main/hostDomain/agentHost.ts`,
`src/main/desktopHost.ts`, locale catalogs, Agent specs, and the aggregate plan.
It does not own preview/cache/session behavior. Coordinate these adapters in the
Draft claim and rebase whichever lands second; do not build against its interim
execution-context mechanism. No dependency/build configuration, protected core
commands/types, board, changelog, or spec index changes are needed. The dormant
office/static-reader plans share preview-shell files and require a fresh claim
check if activated.

## Open questions

None. Shared saved entries belong to content; live display/control state belongs
to a preview. Neither clearing scope removes live displays or pending results.

## Verification

- Cover local defaults, navigation, close/reopen/restart, two same-source panes,
  explicit unavailable models, malformed requests, foreign senders, ambiguous
  targets, stale revisions, delayed/missing acknowledgement, cancellation, and
  capability revocation during native interaction.
- Exercise content/global clears across hot and cold webpage/caption/EPUB shards,
  every configuration variant, pre-model-resolution and pre-record races, queued
  flushes, deletion failures, interrupted cleanup, and restart. Verify one-source
  clearing leaves other sources cached and both same-source live previews intact.
- Verify native cancellation performs no deletion, repeat delivery does not
  duplicate admitted work, session steps report partial effects, and no inspection
  or error leaks private data. Test explicit external/default-session isolation.
- Run typecheck, relevant core/renderer suites, docs checks, and real Electron
  smoke flows with deterministic translation responses and disposable userData.
  Exercise human controls and canonical root-tool invocation, not only direct
  facade calls. Verify provider call counts, cache reuse after reopen/restart,
  actual displayed translations after clearing, and preview-session sign-out.
- Inspect light/dark and narrow-pane UI, keyboard/focus behavior, and teardown.
  Sweep removed preference fields/readers and verify no Settings CLI exists.
  Publish one complete implementation PR; no plan-only merge or staged scaffold.
