# Agent Model Context Language Contract

## Goal

Give the model the smallest coherent Turn brief needed to interpret the user's
request, identify what currently has the user's attention, choose the correct
capability, follow current guidance, and continue safely across history changes.
Model-visible context is designed from those decisions, not from renderer fields,
payload kinds, or reducer mechanics that happen to exist in the runtime.

Canonical evidence remains complete for persistence, audit, replay, diagnostics,
and UI reconstruction. Its model projection is a separate product surface.

This plan is a set of two independently complete features:

1. A semantic Turn-brief compiler, including a canonical attention contract that
   covers every current workspace view.
2. One JSON result envelope for built-in and collaboration tools.

Each feature ships in one complete PR with its own fixtures, measurements,
specification updates, and verification. Feature 1 is ordered after PRs #609 and
#610; Feature 2 is ordered after #610. Neither ships a standalone scaffold.

## Non-goals

- Do not remove canonical fields merely because they are absent from model text.
- Do not make the model-visible brief a pixel-for-pixel description of the UI.
- Do not expose renderer correlation IDs as an Agent actuation interface.
- Do not imply that a file, asset, URL, or trajectory is a Node merely because a
  preview has an owning Node.
- Do not automatically attach complete viewed resources. Resource content remains
  owned by `material` and provider-native media parts.
- Do not infer authority from XML tag spelling; host provenance remains canonical.
- Do not reorder text, images, user messages, tool calls, or tool results.
- Do not make projection depend on an LLM classification pass.
- Do not force prose and machine exchanges into one syntax.
- Do not redesign Skill discovery, invocation admission, provider tool-call
  identity, or canonical compaction state in this work.

## Design

### Product decision

- **OBJ-1:** every injected fact must help the model make at least one defined task
  decision. A canonical field's existence is not evidence that it belongs in model
  context.
- **Minimum acceptable outcome:** a representative multi-Turn conversation is
  understandable without renderer IDs or wire-format reduction; every supported
  workspace view can become an honest attention target; and every projected fact
  has one named decision owner.
- **CON-1 hard:** canonical evidence, not projected prose, remains the state and
  replay authority.
- **CON-2 hard:** application instructions, application observations, and
  untrusted observations remain distinguishable.
- **CON-3 hard:** `<system-reminder>` remains the established context boundary
  described by the stable system prompt. Literal user-authored lookalikes remain
  ordinary untrusted user text.
- **CON-4 hard:** projection is deterministic, provider-neutral, bounded, and
  preserves canonical content ordering.
- **CON-5 legacy:** current context payload kinds and field-level snapshot/delta
  reducers remain useful for persistence, diagnostics, and reconstruction.
- **CON-6 dependency:** Feature 1 overlaps #609 on the Skill catalog/invocation
  contract and `agent-skills.md`, and overlaps #610 on shared Agent protocol and
  provider projection. Feature 2 also meets #610 at the tool-result boundary.
  Rebase after the applicable PRs land, repeat the collision check, and obtain PM
  ratification before editing those surfaces.
- **DEC-1:** model-visible evidence uses the closed semantic `kind` vocabulary
  `environment`, `attention`, `material`, `guidance`, `capabilities`, and
  `continuity`. Canonical payload kinds remain persistence and diagnostic facts.
- **DEC-2:** collaboration tools normalize only model-visible results. Durable
  `details` retain their owning family contract.
- **DEC-3:** opening an asset or linked-file view supplies identity only. Automatic
  content promotion into `material` is deferred because it changes
  privacy, token, and lifecycle behavior.

The clean-slate design would admit semantic context objects directly and never
persist UI-shaped evidence. The selected brownfield target instead adds a semantic
compiler over complete canonical evidence and broadens the canonical user-view
contract only where the evidence currently cannot represent a real workspace
view. This preserves audit and replay without making historical wire fields the
model language.

Two narrower options are rejected:

- Rewriting every payload kind independently still lets historical implementation
  boundaries dictate what the model sees and repeats facts owned by more than one
  payload.
- Hiding panel IDs and compressing time improves one supplied example but leaves
  non-Node views invisible and leaves catalog, invocation, resource, compaction,
  and tool-result languages unrelated.

Revisit provider-native developer/context items if all supported adapters later
offer the same mid-conversation semantics. Until then, the portable reminder
boundary remains the constrained target.

### Evidence and assumptions

- **Evidence:** the workspace supports `outliner`, `file-preview`, and
  `thread-trajectory` views. File preview independently supports local files,
  assets, linked files, and URLs.
- **Evidence:** current renderer capture includes Outliner roots, reduces a
  Node-bound file preview to that Node, drops file previews without a `nodeId`,
  and drops Thread trajectory views entirely. The Agent therefore cannot reliably
  know what the user is viewing.
- **Evidence:** when renderer hints are absent, main currently constructs a virtual
  panel from the Today Node. That converts environment knowledge into a false claim
  about user attention.
- **Evidence:** current user-view projection repeats one Node through panel, focus,
  breadcrumb, visible-row, and detached label records, although no Agent tool
  accepts a panel ID.
- **Evidence:** current environment projection presents accepted UTC time, local
  date, local time, zone, offset, and locale as separate model-visible facts.
- **Evidence:** the stable prompt already defines reminder trust and Skill routing,
  while catalog and invocation projections repeat parts of those contracts.
- **Evidence:** the stable prompt's identity block already names the configured
  persona, so `replyIdentity` is canonical audit data but duplicate model guidance.
- **Evidence gap:** no behavior evaluation proves that raw renderer or reducer
  fields improve task completion.
- **Assumption:** public Node/file references and explicit tool input identities
  are the action surface. UI identity is useful only when it changes the meaning of
  user deixis.

### The five model decisions

| Decision | Question the model must answer | Eligible facts |
| --- | --- | --- |
| **D1 Interpret** | What do words such as "today", "here", "this", and "selected" mean now? | Local time, attention target, distinct focus, non-empty selection, explicit references |
| **D2 Act** | Where and under which runtime constraints should work happen? | Working directory, execution ceiling, interaction mode, usable references accepted by tools |
| **D3 Route** | Which available capability or delegated role matches the task? | Skill and Role availability and meaningful changes |
| **D4 Obey** | Which dynamic instructions and constraints currently apply? | Turn/Thread guidance, active Skill instructions, behavior-changing overrides |
| **D5 Continue** | What prior result or state must survive compaction, restart, fork, or degradation? | Earlier summary, restored semantic state, historical observations, concrete recovery actions |

A projected fact that cannot be traced to D1-D5 stays host-private. The same fact
has one model-visible owner even when several canonical payloads contain it.

### Semantic context taxonomy

The taxonomy is organized by model purpose, not by transport source. Selection
and focus are not independent top-level blocks: they are relationships inside
`attention` and appear only when they identify a distinct referent or action.

| Context type | Model-visible `kind` | Answers | Includes | Excludes by default |
| --- | --- | --- | --- | --- |
| **Environment** | `environment` | What does local time mean, and where may work run? | One local timestamp, effective runtime description, working directory | Accepted UTC duplicate, locale, Today Node, persona, projection mode |
| **Attention** | `attention` | What is the user actually viewing or acting within? | Primary semantic target, other current targets, usable references, distinct focus/selection, bounded excerpt | Panel IDs, renderer flags, empty focus/selection labels, UI reconstruction |
| **Referenced material** | `material` | Which supplied resource content may the model inspect or cite? | Titled reference, usable location, bounded text/media, exceptional availability | Attention-only identity, hashes, storage references |
| **Guidance** | `guidance` | Which dynamic instruction applies now and at what scope? | Authored text, authority, human-readable scope, non-default constraints | Internal keys, hashes, duplicated task text |
| **Capabilities** | `capabilities` | Which Skill or Role can be selected? | Available and meaningfully changed entries | Catalog mode, routing policy already in the stable prompt |
| **Continuity** | `continuity` | What earlier meaning or recovery action must survive history transformation? | Summary, historical observation, semantic restoration, recovery action | Checkpoint mechanics, payload/output references |
| **Native tool exchange** | Provider tool roles, no reminder `kind` | What operation is being called and what happened? | JSON Schema, JSON arguments, shared result envelope, native media | Reminder prose that duplicates the exchange |
| **Diagnostics** | Host-private only | Can the host audit, replay, debug, or reconstruct the context? | Canonical payload kinds, renderer IDs, hashes, reducer modes, timestamps | Direct routine model projection |

The stable prompt defines these six kinds once. Projected diagnostics retain both
the semantic kind and canonical source kind; the latter never appears as routine
model prose. Bodies therefore do not repeat their classification as Markdown
headings.

### Authority and purpose

Semantic grouping never upgrades provenance. One logical block may use adjacent
`<context-evidence>` children when its facts have different authority; conversely,
a sentence that combines authorities receives the least-trusted authority of any
constituent. This keeps the brief coherent without presenting authored labels or
resource content as application instructions.

| Semantic block | Normal authority / purpose | Composition rule |
| --- | --- | --- |
| `environment` | `application / observation` | Contains only host-derived environment facts. |
| `attention` | `untrusted / observation` | Renderer-derived labels and document text make the cohesive statement untrusted; public references remain canonical identity but do not elevate the sentence. |
| `guidance` | Preserved per source | Application instructions and untrusted observations remain separate adjacent children. |
| `material` | Split by provenance | Host-verified locator facts may remain application observations; labels, document/file/web text, and media descriptions remain untrusted observations. |
| `capabilities` | `application / instruction` | Host-admitted Skill/Role discovery only. |
| `continuity` | Preserved or lowered per source | Summaries and historical content remain untrusted observations; restored current state uses each ordinary semantic kind's authority. Host degradation notices use `application / observation`. |

### Attention target contract

`PanelView` is a host UI container. The canonical evidence must instead carry an
extensible semantic target union equivalent to:

```ts
type AttentionTarget =
  | { kind: 'node'; nodeId: string; title: string }
  | { kind: 'local-file'; path: string; label: string; ownerNodeId?: string }
  | { kind: 'asset'; label: string; ownerNodeId?: string; resourceRef?: ThreadResourceReference }
  | { kind: 'linked-file'; sourceText: string; label: string; ownerNodeId?: string }
  | { kind: 'url'; url: string; label?: string; ownerNodeId?: string }
  | { kind: 'thread-trajectory'; threadId: string; threadName: string; turnId?: string };
```

The exact protocol names may follow existing conventions, but the semantic
distinctions are required. Renderer `panelId`, ordering, active/focused flags, and
trajectory record IDs remain canonical correlation data. They are not target
identity unless an Agent tool explicitly accepts them.

Attention projection follows these rules:

1. The active workspace view is the primary target. When more than one real view
   exists, the other targets also appear so "left", "right", "other", and
   cross-view requests are unambiguous. The existing four-panel workspace limit
   bounds the list; display order becomes natural language, never panel IDs.
2. A Node target uses its title and public `[[node://UUID]]` reference. The grammar
   does not branch on date, Daily Note, system, or ordinary Node classes.
3. A local file uses a readable label and canonical `[[file:///absolute/path]]`
   reference when the path is provider-readable. A URL uses the URL itself.
4. Assets and linked files expose only a reference that an Agent capability can
   actually consume. Otherwise they expose descriptive identity plus an owning
   Node reference when available; private `assetId` and `sourceValueId` stay out.
5. A trajectory exposes the readable Thread identity and a `threadId` only because
   collaboration tools accept it. A selected record ID stays private; a bounded
   semantic record description may appear when it changes what "this" means.
6. An owning Node supplements a preview target; it never replaces its file, asset,
   linked-file, or URL identity.
7. Focus emits only when it differs from the primary target or translates to an
   actionable relation such as an insertion target. Raw surface names stay private.
8. Selection emits only when non-empty. A later transition from non-empty to empty
   emits `Selection cleared.` once; an initial empty selection emits nothing.
9. Empty or redundant visible content emits nothing. A non-empty bounded outline
   or resource excerpt appears only when it gives the model referable content.
10. With no renderer-authored view, no `attention` evidence is emitted. The Today
    Node must never be used to synthesize a view.

Viewed resource bytes are not implied by Attention. If the model receives text or
media from a viewed resource, the same reminder carries it under Referenced
material or as an ordered provider-native media part.

### Model-visible blocks

Dynamic evidence remains in ordered `<context-evidence>` children inside
`<system-reminder>`, but each body is a cohesive brief for one semantic context
type rather than a serialization of source fields.

| Model-visible `kind` | Emit when | Contains | Excludes |
| --- | --- | --- | --- |
| `environment` | Initial epoch and meaningful environment changes | One local timestamp, effective execution frame, working directory | Today Node, accepted timestamp duplication, projection mode, default identity |
| `attention` | A real interactive view exists and its semantic state changes | Primary target, relevant other views, distinct focus/selection, bounded excerpt | Synthetic Today view, panel IDs, renderer booleans, duplicate dictionaries |
| `guidance` | Turn/Thread/Skill guidance is set, changed, or cleared | Authored text, authority, human-readable scope, behavior-changing constraints | Internal keys, state-machine markers, task text already in history |
| `material` | User-supplied or context-supplied resource content exists | Titled canonical reference, usable location, relevant snapshot/media, exceptional availability | Separate identity records, hashes, payload references |
| `capabilities` | Initial catalog and meaningful changes | Available, added, updated, and removed Skills/Roles | Catalog mode, hashes, repeated routing policy |
| `continuity` | History is compacted/inherited or state cannot be restored | Earlier summary, ordinary current-state blocks, affected category, recovery action | Checkpoint hashes, restoration flags, payload/output references |

Tool definitions, arguments, and results are not reminder prose. They retain
provider-native tool roles and use JSON Schema plus the shared JSON result
envelope.

### Canonical-to-semantic routing

This routing is exhaustive, but it does not require one visible block per payload.

| Canonical payload | Model-visible destination |
| --- | --- |
| `turnEnvironment` | `environment`; `todayNodeId`, `todayNodeTitle`, accepted time, locale, and reply identity remain host-private |
| `userView` | `attention` only when renderer-authored attention exists |
| `additionalContext` | `guidance`, partitioned by scope, authority, and purpose |
| `referencedResources` | `material` |
| `skillCatalog` | `capabilities` |
| `roleCatalog` | `capabilities` |
| `skillInvocation` | `guidance`; arguments appear only at their canonical user/tool position |
| `toolOutputProjection` | Native tool result projection, not a reminder block |
| `inheritedContext` | Reconstructed ordinary history, not an inheritance marker |
| `compactionSummary` | `continuity` |
| `compactionRestoredState` | Recompiled semantic kinds; restoration mechanics remain private |
| `compactionInstructions` | `guidance` |
| `toolCallArguments` | Native reconstructed tool arguments, never reminder prose |

### Projection rules

1. **Decision ownership:** every visible sentence maps to D1-D5 and one semantic
   kind. Canonical payload kind remains diagnostic provenance, not model language.
2. **Semantic identity:** readable names accompany actionable public references at
   first use.
3. **No UI mirroring:** project what the user is attending to and what the Agent
   can act on, not the component tree needed to render it.
4. **Truth before convenience:** an unavailable view emits no attention rather
   than a guessed or synthetic target.
5. **Dense baseline:** combine related facts into one sentence or compact list. Do
   not make one bullet per source field.
6. **Semantic delta:** later Turns state the changed fact and resulting state. They
   never expose `snapshot`, `delta`, tombstone, or reducer mechanics.
7. **Explicit invalidation:** when a prior actionable target, non-empty selection,
   Skill, Role, or Thread instruction disappears, emit one clear removal statement.
8. **Default omission:** omit false/default/empty values unless absence invalidates
   prior model-visible state.
9. **Single ownership:** local time explains "today"; `attention` owns the
   viewed target; user/tool history owns task text; the stable prompt owns routing
   rules; `material` owns resource content.
10. **Trust preservation:** semantic grouping never raises authority. Mixed
    sentences use the least-trusted constituent; facts that must retain distinct
    authority use adjacent evidence children under the same semantic owner.
11. **Loss signaling:** truncation appears only where it changes completeness,
    such as `Visible excerpt: 80 of 126 nodes`; internal byte limits stay private.

### Projection lifecycle

1. On the first Turn in an epoch, compile one complete semantic baseline from the
   canonical state available at that history position.
2. On a later Turn, compare semantic facts rather than serialized payload fields
   and emit only facts whose meaning changed.
3. If a prior target, selection, or instruction disappears, emit its semantic
   invalidation; unchanged defaults emit nothing.
4. After compaction or reset, compile the same complete baseline language used on
   a fresh Turn. Do not describe the restoration mechanism.
5. If required evidence is unavailable, preserve the Turn and emit the affected
   decision plus a concrete recovery action.

### Complete block comparison

Template notation is normative: `{{camelCase}}` is a required runtime value,
`{{?camelCase}}` is an optional semantic fragment, and ordinary text is fixed
model-visible language. `Removed`, `Host-private`, `Merged into ...`, `Replaced`,
and `Unchanged` are explicit dispositions, not generated output.

| Block | Before | After | Reason |
| --- | --- | --- | --- |
| Reminder boundary | `<system-reminder>`<br>`<context-evidence kind="{{kind}}" authority="{{authority}}" purpose="{{purpose}}">`<br>`{{body}}`<br>`</context-evidence>`<br>`</system-reminder>` | Syntax unchanged | The stable prompt already defines the boundary and provenance remains authoritative. |
| Model-visible `kind` | Canonical source values such as `turnEnvironment`, `userView`, `skillCatalog`, `skillInvocation`, and `compactionSummary` | `environment`, `attention`, `material`, `guidance`, `capabilities`, or `continuity` | One semantic vocabulary replaces implementation-history categories; canonical source kind remains diagnostic. |
| Environment time | `accepted_at={{utcInstant}}`<br>`local_date={{localDate}}`<br>`local_time={{localTime}}`<br>`timezone={{timeZone}}`<br>`utc_offset_minutes={{utcOffsetMinutes}}`<br>`locale={{locale}}` | `Local time: {{localDate}}T{{localTime}}{{utcOffset}} [{{timeZone}}].` | One ISO-like local timestamp preserves the current offset and IANA zone. Accepted time and locale remain canonical. |
| Runtime | `working_directory={{workingDirectory}}`<br>`conversation_mode={{conversationMode}}`<br>`execution_mode={{executionMode}}` | `Runtime: {{runtimeDescription}} in {{workingDirectory}}.` | Raw enums are deterministically translated, for example to `interactive primary-Agent session`. |
| Today | `today_node_id={{todayNodeId}}`<br>`today_node_title={{todayNodeTitle}}` | Host-private; no routine model output | Local date explains "today"; Outline exposes `@today`; a viewed or referenced Today Node follows ordinary Node grammar. |
| Reply identity | `reply_identity={{replyIdentity}}` | Removed from reminder body; stable prompt owns `You are {{replyIdentity}} ...` | The model receives one persona authority. |
| Outliner attention | `panel={{panelId}} root_node_id={{rootNodeId}} root_type={{rootType}} order={{order}} active={{active}} focused={{focused}}`<br>`breadcrumb_node_id={{breadcrumbNodeId}}`<br>`node_id={{nodeId}} title={{nodeTitle}}` | `Viewing "{{rootTitle}}" {{rootNodeReference}} at {{breadcrumbTitles}}.`<br>`{{?visibleOutlineExcerpt}}` | The `attention` wrapper supplies classification; the Node and location are direct. |
| Node-bound file preview | Currently reduced to the owning `root_node_id={{ownerNodeId}}`; preview kind and target are lost | `Viewing file "{{fileLabel}}" {{fileReference}}, opened from "{{ownerNodeTitle}}" {{ownerNodeReference}}.` | The file is the viewed object; the Node is provenance, not a substitute target. |
| Loose local-file preview | No panel output | `Viewing file "{{fileLabel}}" {{fileReference}}.` | Previously invisible attention becomes truthful and actionable. |
| URL preview | No panel output | `Viewing {{url}}.` | The URL itself is the usable semantic identity. |
| Asset preview | No panel output | `Viewing asset "{{assetLabel}}". {{?ownerNodeSentence}} {{?contentAvailabilitySentence}}` | Do not expose private `assetId`; state only identity, usable owner, and actual content availability. |
| Linked-file preview | No panel output | `Viewing linked file "{{fileLabel}}"{{?usableFileReference}}. {{?ownerNodeSentence}}` | Do not expose private `sourceValueId`; include a usable source only when an Agent capability accepts it. |
| Thread trajectory | No panel output | `Viewing trajectory for Thread "{{threadName}}" (thread ID {{threadId}}). {{?selectedRecordDescription}}` | Thread identity is actionable; private renderer record identity is not. |
| Multiple views | Repeated `panel={{panelId}} ... order={{order}} active={{active}}` records | `Viewing {{primaryTargetSentence}}`<br>`Other open views, left to right: {{otherTargetDescriptions}}.` | Preserve only spatial semantics needed for cross-view references. |
| Focus on primary root | `focused_node_id={{rootNodeId}}`<br>`focus_surface=row` | Removed | It repeats the primary target and changes no decision. |
| Distinct focus | `focused_node_id={{focusedNodeId}}`<br>`focus_surface={{focusSurface}}` | `Focused node: "{{focusedNodeTitle}}" {{focusedNodeReference}}.`<br>or `Insertion target: children of "{{parentTitle}}" {{parentReference}}.` | A concrete referent or action replaces an internal surface name. |
| Initial empty selection | `selected_node_ids=none` | Removed | Empty default state does not help D1-D5. |
| Non-empty Node selection | `selected_node_ids={{selectedNodeIds}}` plus detached title records | `Selected: {{selectedNodeReferences}}.` | Each selection is readable and actionable. |
| Selection cleared | `selected_node_ids=none` in a delta | `Selection cleared.` | Absence is relevant only because it invalidates prior visible state. |
| Visible outline | Repeated `visible_node_id={{nodeId}} depth={{depth}} focused={{focused}} collapsed={{collapsed}} child_count={{childCount}}` | `Visible outline:`<br>`{{boundedOutlineMarkup}}`<br>`{{?truncationSentence}}` | Referable content uses outline grammar; empty or root-only content emits nothing. |
| Explicit Node references | `explicit_reference_ids={{nodeIds}}` plus detached title records | Merged into `attention` only when not already owned by User input or `material` | Prevent duplicate references while preserving user deixis. |
| Attention change | `active_panel_id=none`<br>`panel_closed={{panelId}} root_node_id={{closedRootNodeId}}` | `Closed "{{closedTargetTitle}}" {{?closedTargetReference}}. {{?remainingAttentionSentence}}` | Emit semantic invalidation and resulting state, not a tombstone. |
| No real user view | Main synthesizes `panel=today root_node_id={{todayNodeId}}` | No `attention` evidence | Environment state must not masquerade as user attention. |
| Scoped guidance | `key={{key}} source={{source}} lifetime={{lifetime}} state={{state}}` plus authored text | `Scope: {{scopeDescription}}.`<br>`{{authoredText}}` | The `guidance` wrapper supplies type; readable scope remains and state-machine metadata stays private. |
| Referenced material | Separate identity, title, breadcrumb, path, availability, snapshot, and media fragments | `"{{resourceTitle}}" {{usableReference}}`<br>`{{?boundedContentOrMedia}}`<br>`{{?exceptionalAvailability}}` | The `material` wrapper supplies type; one semantic owner holds identity, content, and availability. |
| Skill availability | `mode={{catalogMode}}`<br>`- name={{skillName}} change={{catalogChange}} description={{skillDescription}}`<br>`{{repeatedRoutingRule}}` | `{{skillEntries}}` | The `capabilities` wrapper supplies type; discovery remains while reducer state and repeated policy disappear. |
| Role availability | `mode={{catalogMode}}`<br>`- name={{roleName}} change={{catalogChange}} description={{roleDescription}}`<br>`{{repeatedRoutingRule}}` | `{{roleEntries}}` | Role discovery uses the same `capabilities` grammar. |
| Skill invocation | `name={{skillName}}`<br>`execution={{execution}}`<br>`allowed_tools={{allowedTools}}`<br>`model={{modelOverride}}`<br>`effort={{effortOverride}}`<br>`{{skillInstructions}}`<br>`field=arguments`<br>`{{taskArguments}}` | `Active Skill: {{skillName}}.`<br>`{{skillInstructions}}`<br>`{{?nonDefaultSkillConstraints}}` | The `guidance` wrapper supplies type; defaults and task text already in history disappear. |
| Compaction/restoration | `source=deterministic`<br>`lossy_derived_context=true`<br>`restored_after_compaction=true`<br>`checkpoint={{hash}}` | `Earlier conversation:`<br>`{{summary}}` plus ordinary recompiled semantic kinds | The `continuity` wrapper supplies type; preserve meaning, not compaction mechanics. |
| Degradation | `degraded_context=true`<br>`code={{degradationCode}} source={{degradationSource}} reference={{degradationReference}}` | `{{affectedContext}} could not be restored. {{recoveryAction}}` | The model needs impact and recovery; diagnostics retain the cause. |
| Native tool input | Provider tool definition plus JSON arguments | Unchanged | JSON Schema and JSON are already the machine contract. |
| Built-in tool result | Compact `ToolEnvelope` | Unchanged | It is already the target visible result contract. |
| Collaboration tool result | Raw `success/message` JSON or prose | Replaced by compact `ToolEnvelope` | All tool families share success, unchanged, partial, denied, and error semantics. |

Derived presentation variables are deterministic:

| Variable | Derivation |
| --- | --- |
| `{{utcOffset}}` | Format `{{utcOffsetMinutes}}` as `+/-HH:mm`. |
| `{{runtimeDescription}}` | Translate conversation and execution enums into one stable phrase such as `interactive primary-Agent session`, `headless automation`, or `subagent session`. |
| `{{rootNodeReference}}`, `{{ownerNodeReference}}`, `{{focusedNodeReference}}` | Convert canonical Node IDs to public Node references. |
| `{{fileReference}}` | Convert a provider-readable absolute path to its canonical file reference. |
| `{{breadcrumbTitles}}` | Join resolved titles in display order; never emit a detached ID/title dictionary. |
| `{{?selectedRecordDescription}}` | Resolve the selected trajectory record to bounded semantic text; omit it when unavailable or redundant. |

### Instantiated attention examples

These examples use concrete fixture values so review can judge the resulting
language rather than only the template. Each row is an `attention` body; the
wrapper is omitted here only to keep the examples focused.

| Scenario | Model-visible result |
| --- | --- |
| Current Daily Note opened as an ordinary Node | `Viewing "2026-09-01 #day" [[node://9fbd0994-85dd-4dba-bcf2-1d5a56ced268]] at Tenon / Daily notes / 2026 / W36 / 2026-09-01.` |
| Node-bound local file | `Viewing file "context-design.md" [[file:///Users/lixiaobo/Coding/lin-outliner-codex-3/docs/context-design.md]], opened from "Context design" [[node://0199a001-0000-7000-8000-000000000001]].` |
| Loose local file | `Viewing file "context-design.md" [[file:///Users/lixiaobo/Coding/lin-outliner-codex-3/docs/context-design.md]].` |
| URL | `Viewing https://example.com/context-contract.` |
| Asset without transferable content | `Viewing asset "context-map.png". Its content was not supplied to the model.` |
| Linked file with owner | `Viewing linked file "requirements.md", opened from "Requirements" [[node://0199a001-0000-7000-8000-000000000002]].` |
| Thread trajectory | `Viewing trajectory for Thread "Context contract review" (thread ID 0199a001-0000-7000-8000-000000000003). Selected record: tool result for outline show.` |
| Two real views | `Viewing "Context design" [[node://0199a001-0000-7000-8000-000000000001]]. Other open view to the right: file "context-design.md" [[file:///Users/lixiaobo/Coding/lin-outliner-codex-3/docs/context-design.md]].` |
| Headless or missing renderer hints | No `attention` evidence. |

### Historical field disposition

A historical field does not receive a new standalone label merely because it
existed before.

| Historical field or fragment | Disposition | New owner or rationale |
| --- | --- | --- |
| Canonical payload `kind` in the model-visible wrapper | Replaced by semantic `kind`; retained in diagnostics | The model sees one six-kind taxonomy while audit retains exact source provenance. |
| `projection_mode={{projectionMode}}` | Removed from model text; host-private | Semantic baseline/change language replaces reducer mechanics. |
| `accepted_at={{utcInstant}}` | Removed from reminder body; host-private | Canonical admission and provider message time already own it. |
| `local_date`, `local_time`, `timezone`, `utc_offset_minutes` | Merged into `environment` | Produces one `Local time` sentence. |
| `locale` | Removed from routine model text; host-private | The ISO timestamp is unambiguous and user language is stronger evidence than renderer locale. |
| `working_directory`, `conversation_mode`, `execution_mode` | Merged into `environment` | Produces one `Runtime` sentence. |
| `reply_identity` | Removed from reminder body; host-private | Stable system prompt owns the persona. |
| `today_node_id`, `today_node_title` | Removed from routine model text; host-private | Local date, `@today`, ordinary attention, and explicit references own the useful meanings. |
| `active_panel_id`, `focused_panel_id`, `panel_id` | Removed from model text; host-private | Renderer correlation IDs are not Agent targets. |
| `PanelView.kind` | Replaced by semantic Attention target kind | It determines target grammar but never appears as a raw UI enum. |
| `root_node_id` plus resolved title | Merged into Node attention target | Produces a title and public Node reference. |
| `root_type` | Removed from model text; host-private | Node product class does not alter generic attention grammar. |
| `PreviewTarget.kind` and target data | Merged into file/asset/linked-file/URL attention target | Preserve viewed object identity without leaking private IDs. |
| `threadId`, `turnId`, `selectedRecordId` from trajectory | Partially merged into trajectory attention | Actionable Thread identity and semantic selection remain; private record identity stays host-private. |
| `order`, `active`, `focused` flags | Merged into `attention` only when spatial relation changes interpretation | Raw booleans never appear. |
| Repeated breadcrumb IDs and detached title records | Merged into `attention` | Produces one readable path. |
| `focused_node_id` plus resolved title | Merged into optional `attention` focus | Omitted when redundant; otherwise a titled public reference. |
| `focus_surface` | Removed or translated into optional `attention` relation | Known actionable relations become prose; unknown names stay private. |
| `selected_node_ids` plus resolved titles | Merged into `attention` when non-empty or cleared | Initial empty selection disappears. |
| `explicit_reference_ids` plus resolved titles | Merged into the first applicable owner | Avoid duplication across User input, `attention`, and `material`. |
| Repeated visible-node fields | Merged into optional `attention` excerpt | Produces bounded outline content; empty/root-only projections disappear. |
| False truncation flags | Removed from model text | Complete is the default. |
| True truncation flags | Merged into the affected semantic block | Produces one partial statement without byte-limit details. |
| Panel close tombstone | Merged into `attention` change | Produces closed-target identity and resulting attention state. |
| Catalog modes, hashes, identities, source records | Removed from model text; host-private | Reducers, audit, and restoration own them. |
| Catalog entry identity, description, meaningful change | Merged into `capabilities` | Produces available/added/updated/removed Skill or Role entries. |
| Repeated Skill/Role routing sentences | Removed from catalog blocks | Stable prompt owns routing policy. |
| Skill invocation name and validated instructions | Merged into `guidance` | Produces one active Skill block. |
| Default Skill execution/model/effort/tool constraints | Removed from model text | Defaults do not change behavior. |
| Skill arguments and duplicated task text | Removed from reminder block | Canonical user input or tool call owns the task. |
| Additional-context internal keys and state markers | Removed from body; host-private | Authored content is grouped by effective scope, authority, and purpose. |
| Referenced-resource records | Merged into `material` | One semantic owner holds usable identity, content, and exceptional availability. |
| Compaction implementation markers | Removed from model text; host-private | `continuity` exposes only earlier meaning and current semantic state. |
| Historical observation markers | Merged into `continuity` | Historical content keeps a readable subject and mutable-source warning. |
| Degradation code, source, reference | Removed from model text; diagnostics-private | `continuity` exposes only impact and recovery. |
| Native tool definitions and JSON arguments | Unchanged | JSON Schema and JSON remain the tool-input contract. |
| Built-in visible `ToolEnvelope` | Unchanged | It is already the target model-result contract. |
| Collaboration raw result | Replaced | All model-visible tool results use `ToolEnvelope`. |

### Tool boundary consistency

Consistency means one grammar per semantic boundary, not one grammar for all data.

| Boundary | Contract |
| --- | --- |
| System/developer rules | Markdown |
| Dynamic context | `<system-reminder>` / `<context-evidence>` with semantic Markdown bodies |
| User/assistant communication | Natural language plus canonical references |
| Tool definitions and arguments | JSON Schema and JSON |
| Tool results | Compact JSON `ToolEnvelope`, followed by native media parts |
| Persistence/diagnostics | Typed canonical payloads, never inferred from model prose |

All built-in and collaboration tool results use the same visible states: success,
unchanged, partial, denied, and error. `ok` is sufficient for success/failure;
empty fields and synonymous status strings are omitted. Durable internal details
remain host-private and are not required to parse the model-visible result.

### Requirements

- **FR-1:** a semantic compiler routes every current context payload through D1-D5
  instead of serializing its fields directly.
- **FR-2:** the reminder/evidence syntax, authority, purpose, escaping, ordering,
  and provenance behavior remain intact. Its model-visible `kind` uses only the
  six semantic values; diagnostics separately retain canonical source kind.
- **FR-3:** canonical renderer-to-main evidence distinguishes every supported
  attention target: Outliner Node, local file, asset, linked file, URL, and Thread
  trajectory.
- **FR-4:** `attention` names the primary real target and up to the other three
  current workspace targets using readable, actionable identities without panel
  IDs or detached title maps.
- **FR-5:** distinct focus, non-empty selection, selection clearing, and bounded
  excerpts appear only when they change interpretation or action. Empty defaults
  and raw focus surfaces never appear.
- **FR-6:** Today Node metadata remains canonical but does not receive routine
  model output or synthesize attention when no renderer view exists.
- **FR-7:** viewed resource identity and supplied resource content remain separate;
  `attention` never implies that unseen bytes were provided.
- **FR-8:** stable prompt, catalog, invocation, and user/tool history each own one
  distinct Skill/Role responsibility and never repeat task text.
- **FR-9:** compaction and restoration re-emit ordinary semantic kinds; only an
  actionable recovery statement exposes degradation.
- **FR-10:** built-in and collaboration tools expose the same compact result
  envelope while retaining full durable details privately.
- **NFR-1:** projection is byte-deterministic across replay, restart, fork,
  steering, reset, and compaction.
- **NFR-2:** every projected sentence is traceable to D1-D5, and the complete
  representative fixture has fewer characters and estimated tokens than before.

### Acceptance criteria

- **AC-1 (FR-1):** an exhaustive test maps every canonical context payload kind to
  `environment`, `attention`, `material`, `guidance`, `capabilities`, `continuity`,
  or an explicit host-private/native-tool destination.
- **AC-2 (FR-2):** exact fixtures contain no canonical payload kind in a routine
  model-visible wrapper and reject any semantic kind outside the closed set.
  Literal and closing-tag injection remains escaped and untrusted; renderer or
  document labels never enter an application-instruction block; mixed sentences
  are authority-lowered or split; ordering and diagnostic source provenance remain.
- **AC-3 (FR-3, FR-4):** fixtures cover Outliner, Node-bound local file, loose
  local file, asset, linked file, URL, Thread trajectory, and multiple mixed views.
  Exact output contains no panel ID and never describes a preview as only its owner
  Node.
- **AC-4 (FR-5):** a focus on the viewed root and initial empty selection emit
  nothing; a distinct Node focus uses a titled public reference; a known insertion
  surface becomes an insertion target; a non-empty selection is actionable; and a
  later clear emits exactly `Selection cleared.`
- **AC-5 (FR-6):** date, ordinary, system, and nested Nodes use the same grammar.
  `todayNodeId` and `todayNodeTitle` do not appear in routine model text. Headless
  and missing-renderer fixtures contain no `attention` evidence.
- **AC-6 (FR-7):** identity-only asset and linked-file fixtures state actual
  content availability and contain no private `assetId` or `sourceValueId`.
  Supplied text/image content appears only under `material` or native
  media ordering.
- **AC-7 (FR-8):** the routing rule has one stable owner, catalog contains
  discovery only, and invocation evidence does not repeat task arguments already
  present in canonical history.
- **AC-8 (FR-9):** restored state uses the same target bytes as a fresh semantic
  baseline and contains no checkpoint hash, payload/output reference, or
  restoration marker.
- **AC-9 (FR-10):** success, unchanged, partial, denied, and error fixtures from
  both tool families parse through one visible envelope contract.
- **AC-10 (NFR-1):** exact projections match after replay, restart, fork,
  steering, reset, and compaction.
- **AC-11 (NFR-2):** checked-in comparison output records character and estimated
  token totals for each whole block and the complete multi-Turn fixture; every
  retained fact has a D1-D5 annotation and unexplained regressions fail the test.
- **AC-12:** typecheck, focused Core and renderer tests, full relevant test suites,
  and `docs:check` pass; current behavior is folded into owning specifications.

### Execution units

**Feature A - Semantic Turn brief and attention contract**

- Order this PR after #609 and #610, rebase, and repeat the open-claim/file-scope
  collision check before editing Skill and shared protocol surfaces.
- Extend the renderer-to-main canonical contract and codec with the semantic target
  union; preserve host-private panel correlation and reject no user Turn merely
  because one target cannot be resolved.
- Separate model-visible semantic kind from canonical source kind in projection
  diagnostics, and define the six-kind contract once in the stable prompt.
- Capture all `PanelView` variants, remove Today-based synthetic panels, and retain
  honest no-view state.
- Add a pure semantic planning/formatting layer before XML escaping and route all
  context payload kinds through the decision model.
- Add exact whole-block fixtures, forbidden-token assertions, semantic delta tests,
  panel coverage tests, behavior checks, and density measurements.
- Update `agent-model-runtime.md`, `agent-core.md`, `agent-skills.md`,
  `workspace-layout.md`, and context diagnostics specifications in the same PR.
- Use one clean pre-release protocol cut with no compatibility reader or migrated
  dev data.

**Feature B - Tool result envelope**

- Order this PR after #610, rebase, and repeat the collision check at the provider
  result boundary.
- Route built-in and collaboration tool results through the existing shared
  model-visible envelope abstraction.
- Keep provider-native tool call/result roles and native media ordering.
- Test all visible result states and prevent durable internal details from leaking.
- Update `agent-tool-design.md` and collaboration runtime specifications.

Likely Feature A implementation areas are `protocol.ts`, its codec and IPC
callers, `userViewContext`, `buildUserViewPayload`, `ContextProjector`, an optional
pure semantic brief module, `stablePrompt`, Skill/Role projection, compaction
projection, and focused Core/renderer fixtures. Feature B likely touches
`agentToolEnvelope`, collaboration result adapters, tests, and owning specs.

## Open questions

None. DEC-1 through DEC-3 are the proposed review decisions; implementation starts
only after PM ratification.
