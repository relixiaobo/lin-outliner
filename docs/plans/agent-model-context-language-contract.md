# Agent Model Turn Context Contract

## Goal

Give the model the smallest coherent brief needed to interpret the current user
input, understand the relevant runtime, identify what the user is viewing, choose
an available capability, follow current dynamic instructions, and continue after
history changes.

Canonical evidence remains complete for persistence, audit, replay, diagnostics,
and UI reconstruction. Model-visible context is a separate product surface. It is
designed from model decisions, not from renderer fields, payload kinds, or reducer
mechanics.

This plan is one complete feature in one PR: the Turn-brief compiler and its
canonical view-context contract. Tool-result normalization is a separate feature
and plan.

## Non-goals

- Do not remove canonical fields merely because they are absent from model text.
- Do not make the brief a pixel-for-pixel UI description.
- Do not expose renderer correlation IDs as Agent targets.
- Do not infer that the user is viewing a Node when renderer evidence is absent.
- Do not imply that viewed resource bytes were supplied to the model.
- Do not automatically attach complete viewed resources.
- Do not infer authority or purpose from authored prose or XML tag spelling.
- Do not reorder user content, media, tool calls, or tool results.
- Do not make projection depend on an LLM classification pass.
- Do not redesign provider-native tool roles, tool-result envelopes, Skill
  discovery, or canonical compaction state.

## Design

### Product decision

- **OBJ-1:** every projected statement must help the model interpret the current
  input, act in the current runtime, select a capability, follow a dynamic
  instruction, or recover relevant earlier work.
- **CON-1 hard:** canonical evidence, not projected prose, remains state and replay
  authority.
- **CON-2 hard:** application instructions, application observations, and
  untrusted observations remain distinguishable.
- **CON-3 hard:** `<system-reminder>` remains the established context boundary.
  User-authored lookalikes remain ordinary untrusted user text.
- **CON-4 hard:** projection is deterministic, provider-neutral, bounded, and
  preserves canonical content order.
- **CON-5 hard:** input-scoped environment and renderer state are sampled only at
  Turn-start or steering admission. Host runtime evidence may be published during
  provider preparation; UI changes never asynchronously rewrite a generation.
- **CON-6 dependency:** merged PRs #609 and #610 are the Skill invocation and
  provider-call baseline. Repeat the live collision check before implementation
  because this feature changes adjacent Skill projection and shared Agent protocol.
- **DEC-1:** model-visible `<context>` children have no `kind`. Host-assigned
  `authority` and `purpose` are the complete wrapper protocol.
- **DEC-2:** canonical source kind, stable key, producer, lifecycle, hashes, and
  reducer state remain diagnostic facts and never become reminder syntax.
- **DEC-3:** viewed identity and supplied content have separate model-visible
  owners. Opening a view never promotes its bytes into context.
- **DEC-4:** local time is an input-admission fact, not durable Thread state. One
  compact local timestamp appears with every admitted Turn-start or steering input.
- **DEC-5:** the working directory is Host-owned, Thread-scoped state. It appears
  in the first baseline and when a later admission observes a Host change.

The clean-slate design would admit decision-relevant semantic facts directly and
never persist UI-shaped evidence. The selected brownfield design adds a pure
Turn-brief compiler over complete canonical evidence and broadens renderer capture
only where current evidence cannot identify a real Pane view. This preserves audit
and replay without making historical wire fields part of the model language.

### Evidence and assumptions

- **Evidence:** a Pane displays `outliner`, `file-preview`, or
  `thread-trajectory`; file preview independently supports local files, assets,
  linked files, and URLs.
- **Evidence:** current Agent view capture represents Outliner roots, reduces some
  file previews to an owner Node, and omits loose previews and trajectories.
- **Evidence:** current fallback can synthesize a Today panel when renderer hints
  are missing, turning environment state into a false view claim.
- **Evidence:** current environment projection emits UTC acceptance time, local
  date/time, zone, offset, locale, cwd, execution enums, identity, and Today data
  as separate fields.
- **Evidence:** Turn start and steering use the same atomic evidence-before-user
  admission path; ordinary renderer changes have no independent admission path.
- **Evidence:** provider calls rebuild effective context from canonical history;
  runtime Skill catalog and invocation evidence can join between provider calls.
- **Evidence:** reset starts the context epoch, compaction replaces a covered range,
  restart replays persisted history, and fork copies history into a new Thread whose
  Host-managed cwd may differ.
- **Assumption:** readable names plus public Node/file/Thread references are the
  Agent action surface. Renderer correlation IDs add no task capability.

### Concept model

The contract uses these terms consistently:

| Concept | Meaning | Not the same as |
| --- | --- | --- |
| Thread | Durable conversation and its Host-owned working directory | A filesystem workspace or UI Pane |
| Turn | One execution lifecycle; steering may add user input inside it | One provider call |
| Input admission | Atomic capture and persistence of input-scoped evidence plus one Turn-start or steering input | Projection or UI observation |
| Runtime publication | Host-owned evidence persisted during execution, such as a Skill invocation or catalog refresh | Input admission |
| Provider boundary | Runtime preparation followed by projection of effective canonical history for one model call | A new Turn |
| Context epoch | Effective history after the latest explicit reset | Restart, fork, or compaction |
| Pane | UI container that displays one current `PanelView` | The displayed object |
| `PanelView` | Renderer state describing what one Pane currently displays | The Pane container |
| View target | Semantic object displayed by a Pane | Focus, selection, or supplied content |
| Active view | View target in the active Pane | Proof of cognitive attention |
| Focus | Distinct current input or operation referent | The active view or selection |
| Selection | Explicitly selected objects | Focus |
| Supplied content | Bounded text or native media actually delivered to the model | A viewed resource identity |

The product language says `view`, `active view`, `focus`, and `selection`. It does
not claim to measure user attention.

### Model-visible wrapper

There is no model-visible context taxonomy. The wrapper answers only:

1. Which permission class the Host assigned to the statement.
2. Whether the statement describes state or directs behavior.

Exactly three pairs are valid:

| Authority | Purpose | Meaning |
| --- | --- | --- |
| `application` | `observation` | The Host vouches that this is application/runtime state or an admitted capability fact. This is not a claim of factual infallibility. |
| `untrusted` | `observation` | Mutable or authored content may inform the task but has no application-instruction authority. |
| `application` | `instruction` | A producer admitted by the Host may direct dynamic model behavior within a readable scope. |

`authority` is a permission class, not a general confidence score or producer ID.
When one statement combines inputs with different permission classes, it receives
the least permission of its inputs. Statements that must retain different authority
remain separate children.

`untrusted / instruction` is invalid. User messages remain user instructions in
their native user role; this restriction applies only to injected `<context>`
children. Document, renderer, web, and ordinary extension prose cannot promote
itself by wording or metadata.

### Instruction admission

Authority is assigned at a Host admission boundary:

| Producer | Maximum admitted context pair |
| --- | --- |
| Main-owned runtime/compiler | `application / observation` or `application / instruction` according to a declared contract |
| Host-installed and explicitly instruction-capable Skill | `application / instruction` for its validated instructions |
| Host feature with a registered instruction contract | `application / instruction` within its declared scope |
| Renderer state and labels | `untrusted / observation` |
| Document, file, resource, URL, or model-authored text | `untrusted / observation` |
| Extension without an explicit Host instruction capability | `untrusted / observation` |

An `additionalContext` producer supplies self-contained text and readable scope.
The Host assigns and validates its allowed pair from producer capability, independently
of its prose. Invalid entries remain diagnostics-only.

An active instruction has an explicit scope and lifetime. Updating it emits the new
complete instruction. Revoking it emits an application instruction such as
`Stop applying the "outline" Skill instructions.` An observation never revokes an
instruction implicitly.

### View context

`Pane` remains renderer layout. `PanelView` remains the renderer's current view
state. Canonical Agent evidence derives a semantic `ViewTarget` equivalent to:

```ts
type ViewTarget =
  | { kind: 'node'; nodeId: string; title: string }
  | { kind: 'local-file'; path: string; label: string; ownerNodeId?: string }
  | { kind: 'asset'; label: string; ownerNodeId?: string; resourceRef?: ThreadResourceReference }
  | { kind: 'linked-file'; sourceText: string; label: string; ownerNodeId?: string }
  | { kind: 'url'; url: string; label?: string; ownerNodeId?: string }
  | { kind: 'thread-trajectory'; threadId: string; threadName: string; turnId?: string };
```

The exact protocol names may follow existing conventions. The semantic distinctions
are required.

1. The active Pane's view is primary. Up to the other three open views appear only
   when they make cross-view language such as “left” or “the other file” resolvable.
2. Any change to the open-view set, primary view, or spatial relationship emits one
   complete resulting view statement. Model prose never emits `panel_closed` or a
   partial renderer patch.
3. A Node uses its readable title and public `[[node://UUID]]` reference. Date,
   Daily Note, system, and ordinary Nodes use the same grammar.
4. A local file uses a label and provider-readable `[[file:///absolute/path]]`
   reference. A URL uses the URL itself.
5. Assets and linked files expose only references accepted by an Agent capability.
   Private `assetId` and `sourceValueId` remain Host-private.
6. A trajectory exposes readable Thread identity and `threadId` because
   collaboration tools accept it. Private selected record IDs remain Host-private.
7. An owning Node supplements a preview target; it never replaces the file, asset,
   linked file, or URL being viewed.
8. Focus emits only when it differs from the active view and resolves to an
   actionable referent or relation. When that distinct focus disappears, emit
   `Focus returned to the active view.`
9. Selection emits only when non-empty. A later clear emits `Selection cleared.`
   exactly once; an initial empty selection emits nothing.
10. With no renderer-authored view, emit no view statement. Today metadata must
    never synthesize one.

View identity never implies content availability. If a bounded visible Outline,
file excerpt, or other resource text is admitted, an adjacent untrusted observation
names the source and owns that content. Media remains an ordered provider-native part.

### Fact ownership

Each semantic fact has one visible owner:

| Fact | Owner | Lifecycle |
| --- | --- | --- |
| Local time | Admission statement preceding its input | Every Turn-start/steering admission |
| Working directory | Thread execution observation | Baseline and changed value |
| Non-default execution behavior | Thread execution observation | Baseline and changed value |
| Open and active views | Complete current-view statement | Baseline and complete replacement |
| Distinct focus | Focus statement | Set, replace, or explicit return to active view |
| Selection | Selection statement | Non-empty set/replace or explicit clear |
| Supplied resource text | Supplied-content observation | At the canonical position where content is supplied |
| User task text | Native user message | Never repeated in context |
| Capability availability | Skill/Role catalog observation | Baseline, then readable additions/updates/removals |
| Skill instructions | Scoped application instruction | Set, replace, or explicit revoke |
| Tool arguments/results | Provider-native tool roles | Never reminder prose |
| Earlier conversation | Compaction summary observation | Compaction position only |

### Projection lifecycle

Context is not pushed whenever mutable state changes. Input-scoped state and
runtime-derived evidence have separate publication paths.

#### Admission boundary

A new Turn start and a steering message are input-admission boundaries. The Host
samples one coherent instant and atomically persists eligible context evidence
immediately before the associated input Item.

At admission:

1. Capture the local timestamp and current Thread execution state.
2. Capture renderer-authored view state if supplied with that admission.
3. Resolve current Skill/Role availability and admitted invocation instructions.
4. Admit registered additional context and explicitly referenced resources.
5. Compare stateful semantic facts with the model's effective prior state.
6. Persist the resulting canonical evidence followed by the user Item.

Document-drift notices remain between-Turn only. Steering does not add one while the
model may be composing the mutation that caused the drift.

#### Provider boundary

Before each provider call, the Host may publish runtime-derived evidence that does
not require renderer or input-state sampling. This includes a changed Skill catalog
and a frozen tool-output observation; successful Skill invocation evidence is
published when that tool completes. The runtime then projects the complete effective
canonical history, so all such evidence becomes visible at this boundary.

A renderer-only view change during execution does nothing by itself. It is sampled
only if a later Turn-start or steering admission carries renderer state. Tool
results remain native tool-result messages and are not converted into context
blocks.

#### Baseline, change, and invalidation

- When effective history contains no prior semantic state, the first admission
  emits a complete baseline. This includes a fresh Thread and the first admission
  after reset, but not a fork that inherited context.
- A later admission emits the local timestamp plus only changed stateful facts.
- A complete view statement replaces the previous view state; no close tombstone is
  needed.
- Optional facts such as focus, selection, and instructions use explicit clearing or
  revocation language when disappearance would otherwise leave stale behavior.
- Unchanged defaults and empty values emit nothing.
- Projected text never exposes `snapshot`, `delta`, `set`, `clear`, tombstones, or
  reducer keys.

#### Reset, compaction, restart, and fork

| Event | Context meaning | Verification standard |
| --- | --- | --- |
| Replay | Same canonical history projected again | Byte-identical output |
| Process restart | No new epoch; reload and project the same canonical history | Byte-identical output until a new admission adds facts |
| Explicit reset | Starts a new context epoch after the reset Item | Next admitted input emits a fresh baseline |
| Compaction | Same epoch; covered history is replaced by summary plus validated current-state checkpoint | Current effective facts and instruction scopes are semantically equivalent; summary bytes intentionally differ |
| Fork | Copied terminal history starts a new Thread without creating an implicit reset | Inherited history remains equivalent; the first new admission emits differences owned by the new Thread, including cwd |

`deterministic` therefore means identical canonical input produces identical bytes.
It does not mean reset, compaction, steering, and fork produce the same transcript.

#### Failure and recovery

- An unresolved or unsupported view target is omitted while the user Turn
  continues; it never becomes a synthetic Node view.
- Invalid producer authority remains diagnostic and emits no model instruction.
- Unavailable optional supplied content emits identity and bounded availability
  only when that changes the model's next decision.
- A failed restoration emits an observation naming the affected context. Any
  required recovery behavior is a separate application instruction.
- Runtime inspection failures degrade the affected fact and do not reject an
  already-admitted user message.

### Time and working directory

Time and cwd have different semantics:

- Local time belongs to one input admission. Emit exactly one compact line with local
  date, time, numeric offset, and IANA zone. Do not emit UTC acceptance time,
  locale, or separate date/time/offset fields.
- Cwd is sticky Thread execution state. Sample it at every admission, emit it in a
  baseline, and emit it again only if it changed.
- Ordinary interactive root execution is the default and emits no `Execution:`
  line. Headless Automation or another behavior-changing mode emits a readable
  description.
- Ordinary users and the model cannot change a Thread's cwd. Automation startup,
  root-Thread creation/fork, and Host-managed child worktrees may choose it.
- The Host must not mutate cwd during an active provider execution. A permitted
  Host change settles before the next admission, where it becomes canonical
  evidence.

Representative baseline:

```xml
<system-reminder>
<context authority="application" purpose="observation">
Local time at this message: 2026-09-01T11:14:11+08:00 [Asia/Shanghai].
Working directory: /Users/lixiaobo/Coding/lin-outliner-codex-3.
</context>
<context authority="untrusted" purpose="observation">
Viewing "Context design" [[node://0199a001-0000-7000-8000-000000000001]] at Tenon / Plans / Context design.
</context>
</system-reminder>
```

### Multi-Turn examples

The first user message receives the baseline above. If the user changes only the UI,
nothing is injected. When the user later sends a message from a file view:

```xml
<system-reminder>
<context authority="application" purpose="observation">
Local time at this message: 2026-09-01T11:18:42+08:00 [Asia/Shanghai].
</context>
<context authority="untrusted" purpose="observation">
Now viewing file "requirements.md" [[file:///Users/lixiaobo/Coding/lin-outliner-codex-3/requirements.md]].
</context>
</system-reminder>
```

If that message is steering an active Turn, the same evidence and user input are
persisted as one ordered admission group and delivered to the active executor. A view
change with no steering message remains unobserved until a later admission.

If a previously non-empty selection becomes empty:

```xml
<context authority="untrusted" purpose="observation">
Selection cleared.
</context>
```

If a scoped Skill instruction is revoked:

```xml
<context authority="application" purpose="instruction">
Stop applying the "outline" Skill instructions.
</context>
```

After compaction, historical prose uses an observation and current instructions keep
their instruction wrapper:

```xml
<system-reminder>
<context authority="untrusted" purpose="observation">
Earlier conversation:
The user and Agent agreed to simplify model-visible context and preserve canonical evidence.
</context>
<context authority="application" purpose="instruction">
Active Skill: outline.
Use the Outline CLI as the only document access path.
</context>
</system-reminder>
```

### Complete block comparison

Template notation is normative: `{{camelCase}}` is required runtime data and
`{{?camelCase}}` is optional semantic text. `Removed`, `Host-private`, and `Merged`
are dispositions, not generated output.

| Block | Before | After | Reason |
| --- | --- | --- | --- |
| Reminder child | `<context-evidence kind="turnEnvironment" authority="application" purpose="observation">` | `<context authority="application" purpose="observation">` | Preserve authority and purpose; remove canonical source classification from model syntax. |
| Reducer mode | `projection_mode={{projectionMode}}` | Removed; Host-private | Baseline/change mechanics are inferred from history and expressed as resulting state. |
| Local time | `accepted_at={{utcInstant}}`<br>`local_date={{localDate}}`<br>`local_time={{localTime}}`<br>`timezone={{timeZone}}`<br>`utc_offset_minutes={{utcOffsetMinutes}}`<br>`locale={{locale}}` | `Local time at this message: {{localDate}}T{{localTime}}{{utcOffset}} [{{timeZone}}].` | One input-admission line replaces six transport fields. |
| Working directory | `working_directory={{workingDirectory}}` | `Working directory: {{workingDirectory}}.` | A sticky Thread execution fact, emitted at baseline and after a Host change. |
| Execution enums | `conversation_mode={{conversationMode}}`<br>`execution_mode={{executionMode}}` | `Execution: {{nonDefaultExecutionDescription}}.` or Host-private | Omit the interactive-root default; describe only behavior-changing modes. |
| Today metadata | `today_node_id={{todayNodeId}}`<br>`today_node_title={{todayNodeTitle}}` | Host-private | Local time explains today; `@today` and ordinary Node references are the action surface. |
| Reply identity | `reply_identity={{replyIdentity}}` | Removed; stable prompt owns persona | Avoid two persona authorities. |
| Pane identity | `active_panel_id={{panelId}}`<br>`focused_panel_id={{panelId}}`<br>`panel={{panelId}} ...` | Removed; Host-private | Pane IDs correlate renderer state but are not Agent targets. |
| Outliner view | `root_node_id={{rootNodeId}}` plus detached title and breadcrumb records | `Viewing "{{rootTitle}}" {{rootNodeReference}} at {{breadcrumbTitles}}.` | Name the semantic view target directly. |
| Local-file view | Missing, or reduced to `root_node_id={{ownerNodeId}}` | `Viewing file "{{fileLabel}}" {{fileReference}}{{?ownerNodeClause}}.` | The file is the target; an owner Node is optional provenance. |
| Asset view | No panel output | `Viewing asset "{{assetLabel}}"{{?ownerNodeClause}}.` | Identity only; private asset IDs and unseen content stay out. |
| Linked-file view | No panel output | `Viewing linked file "{{fileLabel}}"{{?usableReference}}{{?ownerNodeClause}}.` | Include only a reference an Agent capability can use. |
| URL view | No panel output | `Viewing {{url}}.` | The URL is the semantic identity. |
| Thread trajectory view | No panel output | `Viewing trajectory for Thread "{{threadName}}" (thread ID {{threadId}}){{?recordDescription}}.` | Thread identity is actionable; private renderer record identity is not. |
| Multiple views | Repeated `panel={{panelId}} order={{order}} active={{active}}` | `Viewing {{primaryTarget}}. Other open views, left to right: {{otherTargets}}.` | Preserve useful spatial meaning without component IDs. |
| View closure/change | `panel_closed={{panelId}} root_node_id={{nodeId}}` | Complete replacement view statement | Resulting state is clearer than a renderer tombstone. |
| Missing renderer view | Synthetic Today panel | No view statement | Environment knowledge must not masquerade as a user view. |
| Focus on active view | `focused_node_id={{rootNodeId}}`<br>`focus_surface=row` | Removed | Redundant with the active view. |
| Distinct focus | `focused_node_id={{focusedNodeId}}`<br>`focus_surface={{surface}}` | `Focused node: "{{title}}" {{reference}}.` or `Insertion target: children of "{{title}}" {{reference}}.` | Translate only an actionable referent or relation. |
| Focus cleared | `focused_node_id=none` | `Focus returned to the active view.` when a distinct prior focus existed | Explicitly invalidates the optional focus fact. |
| Initial empty selection | `selected_node_ids=none` | Removed | Empty default changes no decision. |
| Non-empty selection | `selected_node_ids={{ids}}` plus detached labels | `Selected: {{titledReferences}}.` | Readable, actionable identity. |
| Selection cleared | `selected_node_ids=none` delta | `Selection cleared.` | Explicitly invalidates prior selection. |
| Visible Outline content | Repeated `visible_node_id`, depth, collapsed, and count fields inside user view | Adjacent supplied-content observation with source identity and bounded Outline markup | View state and delivered content have separate owners. |
| Explicit Node references | `explicit_reference_ids={{ids}}` plus detached labels | Merged into native user content or supplied-content identity | Prevent duplicate references. |
| Additional context | `kind="additionalContext"` plus `key`, `source`, `lifetime`, and `state` | Self-contained text under its Host-admitted pair, with readable scope only when behaviorally relevant | Intake and reducer metadata are not model categories. |
| Referenced resource | Separate Node ID, title, breadcrumb, path, availability, content, and media fragments | Identity statement followed by bounded supplied text or native media | One content owner without implying that viewing supplied bytes. |
| Skill availability | `mode={{mode}}`, hashes, `change={{change}}`, and repeated routing rule | `Available Skills:` plus initial entries or readable additions/updates/removals | Discovery is observation; stable prompt owns routing. |
| Role availability | `mode={{mode}}`, hashes, `change={{change}}`, and repeated routing rule | `Available Roles:` plus initial entries or readable additions/updates/removals | Same catalog grammar as Skills. |
| Skill invocation | Name, execution, default constraints, instructions, and duplicated arguments | `Active Skill: {{skillName}}.` plus validated instructions and only non-default behavior constraints | Instruction owner is distinct from user/tool task text. |
| Skill revocation | Reducer disappearance or reset mechanics | `Stop applying the "{{skillName}}" Skill instructions.` | Revocation is an instruction, not an observation. |
| Compaction | `lossy_derived_context`, `restored_after_compaction`, checkpoint hashes | `Earlier conversation:` plus ordinary current facts and scoped instructions | Preserve meaning, not restoration mechanics. |
| Degradation fact | `degraded_context=true code={{code}} source={{source}}` | `{{affectedContext}} could not be restored.` | Observation states impact; diagnostics retain cause. |
| Required recovery behavior | Appended inside a degradation observation | Separate application instruction such as `Read {{resource}} again before relying on it.` | Commands must not hide inside observation text. |
| Tool input/result | Provider-native definition, JSON arguments, and result role | Unchanged | Tool exchanges are not reminder prose. |

Derived presentation variables are deterministic:

| Variable | Derivation |
| --- | --- |
| `{{utcOffset}}` | Format canonical offset minutes as `+/-HH:mm`. |
| `{{nonDefaultExecutionDescription}}` | Translate only a non-default mode that changes model behavior. |
| `{{rootNodeReference}}` and other Node references | Convert canonical Node IDs to public Node references. |
| `{{fileReference}}` | Convert a provider-readable absolute path to its canonical file reference. |
| `{{breadcrumbTitles}}` | Join resolved titles in display order; never emit a detached ID/title dictionary. |
| `{{?recordDescription}}` | Resolve a selected trajectory record to bounded semantic text; omit when unavailable or redundant. |

### Canonical routing

| Canonical payload | Model-visible treatment |
| --- | --- |
| `turnEnvironment` | Admission-scoped local time plus changed Thread execution state; Today, locale, UTC admission time, and reply identity remain Host-private |
| `userView` | Complete view state, optional focus/selection state, and no supplied content |
| `additionalContext` | Host-admitted self-contained observation or instruction; internal source/key remain diagnostic |
| `referencedResources` | Untrusted supplied-content observation plus provider-native media |
| `skillCatalog` | Application observation |
| `roleCatalog` | Application observation |
| `skillInvocation` | Application instruction; arguments stay in their native user/tool position |
| `toolOutputProjection` | Native tool history or a separately admitted historical observation, never a context category |
| `inheritedContext` | Reconstructed ordinary history, not an inheritance marker |
| `compactionSummary` | Untrusted observation introduced as `Earlier conversation:` |
| `compactionRestoredState` | Recompiled current facts and instructions without restoration markers |
| `compactionInstructions` | Host-validated application instruction |
| `toolCallArguments` | Native reconstructed tool arguments |

### Boundary syntax

Consistency means one grammar per semantic boundary:

| Boundary | Contract |
| --- | --- |
| Stable system/developer rules | Markdown |
| Dynamic context | `<system-reminder>` with `<context authority="..." purpose="...">` children and readable bodies |
| User/assistant communication | Natural language plus canonical references |
| Tool definitions and arguments | JSON Schema and JSON |
| Tool results | Provider-native tool-result role and its owning result contract |
| Persistence/diagnostics | Typed canonical payloads, never inferred from model prose |

## Requirements

- **FR-1:** a pure Turn-brief compiler applies the inclusion and single-owner rules
  instead of serializing payload fields.
- **FR-2:** model-visible wrappers use only the three admitted authority/purpose
  pairs and contain no canonical source `kind`.
- **FR-3:** Host admission assigns authority from producer capability; authored
  text and metadata cannot self-promote.
- **FR-4:** canonical renderer evidence distinguishes Pane, `PanelView`, every
  supported semantic view target, distinct focus, selection, and supplied content.
- **FR-5:** view changes emit complete resulting state without Pane IDs, reducer
  fields, or close tombstones.
- **FR-6:** local time emits once per Turn-start/steering admission; cwd emits at
  baseline and after a settled Host change; default execution enums emit nothing.
- **FR-7:** a viewed identity never implies content availability. Supplied text and
  native media retain their own ordered content position.
- **FR-8:** Skill/Role discovery, Skill instructions, user task text, and tool
  exchanges each retain one owner.
- **FR-9:** optional state and instructions use explicit semantic clearing or
  revocation.
- **FR-10:** reset, compaction, restart, fork, steering, and replay follow their
  distinct lifecycle and verification rules.
- **NFR-1:** identical canonical input projects to byte-identical output.
- **NFR-2:** every projected statement has a fixture-recorded inclusion rationale;
  the representative multi-Turn fixture is smaller than the current projection.

## Acceptance criteria

- **AC-1 (FR-1, FR-2):** exhaustive routing fixtures map every canonical payload
  to one admitted pair or an explicit Host-private/native destination; routine
  output contains no `kind`, reducer mode, hash, internal key, or source marker.
- **AC-2 (FR-3):** matrix tests accept only the three documented pairs. Renderer,
  document, URL, ordinary extension, malformed metadata, and authored XML spoofing
  cannot produce application instructions.
- **AC-3 (FR-4, FR-5):** fixtures cover Outliner Node, local file with and without
  owner, asset, linked file, URL, Thread trajectory, mixed multiple views, complete
  view replacement, missing renderer state, distinct focus, and selection clearing.
- **AC-4 (FR-6):** each Turn-start and steering admission emits one compact
  local-time line. A fresh Thread and a fork's first new admission emit the correct cwd; an
  unchanged cwd does not repeat; headless Automation receives a readable execution
  description while an interactive root does not.
- **AC-5 (FR-7):** current-view fixtures contain no resource body. Supplied text
  appears only in an adjacent untrusted observation and images retain native media
  order. Private asset/source IDs never appear.
- **AC-6 (FR-8, FR-9):** catalog output contains discovery only, invocation output
  omits task arguments already in history, and instruction revoke fixtures use an
  application instruction rather than an observation.
- **AC-7 (FR-10):** replay and restart fixtures are byte-identical; reset produces
  a fresh baseline; compaction preserves current semantic facts and instruction
  scopes while changing historical summary bytes; fork preserves inherited history
  and emits new Thread-owned differences; steering preserves atomic evidence-before-
  user order.
- **AC-8:** UI-only changes during a running Turn produce no injected message; the
  same state carried by a later steering or Turn admission produces the expected
  semantic update.
- **AC-9 (NFR-2):** checked-in comparison output records character and estimated
  token totals for each block and the complete multi-Turn fixture; unexplained
  regressions fail the test.
- **AC-10:** typecheck, focused Core/renderer tests, complete relevant suites, and
  `docs:check` pass; current behavior is folded into owning specifications.

## Execution

- Start from the merged #609/#610 baseline, repeat the open-claim/file-scope
  collision check, and obtain PM ratification before editing shared protocol
  surfaces.
- Extend renderer-to-main canonical evidence to cover all `PanelView` variants
  while preserving Host-private Pane correlation.
- Remove Today-based synthetic views and retain honest no-view state.
- Add the pure semantic-state and formatting layer before XML escaping.
- Route every canonical context payload through the ownership and admission rules.
- Add explicit instruction-capability admission for eligible Host producers and
  downgrade or reject invalid additional-context entries without failing a Turn.
- Preserve atomic start/steering evidence admission and provider-native tool roles.
- Add whole-message, multi-Turn, same-Turn steering, runtime Skill update, reset,
  compaction, restart, and fork fixtures plus density measurements.
- Update `agent-model-runtime.md`, `agent-core.md`, `agent-skills.md`,
  `workspace-layout.md`, and context diagnostics specifications in the same PR.
- Use one clean pre-release protocol cut with no compatibility reader or migrated
  dev data.

Likely implementation areas are `protocol.ts`, its codec and IPC callers,
`workspaceLayoutTypes`, user-view capture, `buildUserViewPayload`,
`ContextProjector`, a pure Turn-brief module, `stablePrompt`, Skill/Role projection,
compaction projection, and focused Core/renderer fixtures.

## Open questions

None. DEC-1 through DEC-5 and the lifecycle tables are the proposed review
decisions; implementation starts only after PM ratification.
