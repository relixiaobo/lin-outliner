# Agent Model Turn Context Contract

## Goal

Give the model the smallest coherent Turn brief needed to interpret the user's
request, identify what currently has the user's attention, choose the correct
capability, follow current guidance, and continue safely across history changes.
Model-visible context is designed from those decisions, not from renderer fields,
payload kinds, or reducer mechanics that happen to exist in the runtime.

Canonical evidence remains complete for persistence, audit, replay, diagnostics,
and UI reconstruction. Its model projection is a separate product surface.

This plan is a set of two independently complete features:

1. A Turn-brief compiler, including a canonical attention contract that
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
- Do not automatically attach complete viewed resources. Supplied resource text
  remains a distinct observation and media remains provider-native.
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
  has one clear reason to exist and one model-visible owner.
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
- **DEC-1:** each model-visible `<context>` has no `kind`. Its only protocol
  dimensions are Host-assigned `authority` and `purpose`; canonical payload kinds
  remain persistence and diagnostic facts.
- **DEC-2:** collaboration tools normalize only model-visible results. Durable
  `details` retain their owning family contract.
- **DEC-3:** opening an asset or linked-file view supplies identity only. Automatic
  content promotion into the Turn brief is deferred because it changes
  privacy, token, and lifecycle behavior.
- **DEC-4:** `additionalContext` is a canonical intake source, not a model-visible
  category. Each entry carries Host-admitted authority, purpose, readable scope,
  and self-contained text. Internal keys remain diagnostic; prose never determines
  authority or purpose.

The clean-slate design would admit decision-relevant context facts directly and
never persist UI-shaped evidence. The selected brownfield target instead adds a
Turn-brief compiler over complete canonical evidence and broadens the canonical
user-view contract only where the evidence currently cannot represent a real
workspace view. This preserves audit and replay without making historical wire
fields or a second semantic type system part of the model language.

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

### Inclusion test

A fact projects only when removing it could change how the model interprets the
current request, acts in the current runtime, selects an available capability,
follows a dynamic instruction, or continues earlier work. Everything else stays
host-private. The same fact has one model-visible owner even when several
canonical payloads contain it.

### Model-visible context contract

There is no model-visible context taxonomy. The wrapper answers only two protocol
questions: how much the model may trust the body, and whether the body describes
reality or directs behavior. The body itself uses ordinary, self-contained
language such as `Local time: ...`, `Viewing ...`, `Available Skills:`, or
`Earlier conversation:`. These phrases are presentation, not extensible protocol
values.

Exactly three authority/purpose pairs are admitted:

| Authority | Purpose | Use |
| --- | --- | --- |
| `application` | `observation` | Host-verified facts, capability availability, and actionable recovery state. |
| `untrusted` | `observation` | Renderer labels, document/resource content, and summaries derived from mutable or authored sources. |
| `application` | `instruction` | Host-admitted dynamic instructions, including active Skill instructions. |

`untrusted / instruction` is invalid. Text from a document, renderer, web page, or
extension cannot become an instruction by wording itself as one. A sentence that
combines authorities receives the least-trusted authority; facts that need
different authority use adjacent context children. Catalogs describe available
capabilities as application observations; the stable prompt, not each catalog,
owns the instruction to select a matching capability.

Canonical source kind, stable key, reducer mode, and lifecycle remain available in
the diagnostic sidecar. They never appear in the reminder wrapper or body.

A representative baseline is therefore:

```xml
<system-reminder>
<context authority="application" purpose="observation">
Local time: 2026-09-01T11:14:11+08:00 [Asia/Shanghai].
Runtime: interactive primary-Agent session in /Users/lixiaobo/Coding/lin-outliner-codex-3.
</context>
<context authority="untrusted" purpose="observation">
Viewing "2026-09-01 #day" [[node://9fbd0994-85dd-4dba-bcf2-1d5a56ced268]] at Tenon / Daily notes / 2026 / W36 / 2026-09-01.
</context>
</system-reminder>
```

Available Skill/Role entries use an application-observation child. Only actual
dynamic instructions use an application-instruction child.

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
10. With no renderer-authored view, no current-view sentence is emitted. The Today
    Node must never be used to synthesize a view.

Viewing a resource does not imply that its bytes were supplied. If the model
receives text from that resource, an adjacent untrusted observation identifies the
resource and contains the bounded text; media remains an ordered provider-native
part.

### Model-visible content

Dynamic context remains in ordered `<context>` children inside
`<system-reminder>`. Adjacent content with the same authority and purpose is
combined when ordering permits; a body may contain several related sentences or
readable sections. Content is selected by meaning, not by a required section list.

| Purpose | Emit when | Contains | Excludes |
| --- | --- | --- | --- |
| `observation` | A decision-relevant fact first exists, meaningfully changes, or invalidates prior context | Dense, self-contained statements about local execution, the current view, supplied resources, available capabilities, earlier context, or recovery | Source fields, duplicate identities, defaults, hashes, reducer/lifecycle mechanics |
| `instruction` | A Host-admitted dynamic instruction is set, changed, or cleared | Instruction text, readable scope, and behavior-changing constraints | Observations, internal keys, state-machine markers, task text already in history |

Tool definitions, arguments, and results are not reminder prose. They retain
provider-native tool roles and use JSON Schema plus the shared JSON result
envelope.

### Canonical-to-brief routing

This routing is exhaustive, but it does not require one visible block per payload.

| Canonical payload | Model-visible treatment |
| --- | --- |
| `turnEnvironment` | Application observation; `todayNodeId`, `todayNodeTitle`, accepted time, locale, and reply identity remain host-private |
| `userView` | Untrusted observation only when renderer-authored attention exists |
| `additionalContext` | Host validates authority/purpose and emits self-contained text with readable scope; internal key/source remain diagnostic |
| `referencedResources` | Observation using the least-trusted authority of the locator, label, and supplied content |
| `skillCatalog` | Application observation |
| `roleCatalog` | Application observation |
| `skillInvocation` | Application instruction; arguments appear only at their canonical user/tool position |
| `toolOutputProjection` | Native tool result projection, not a reminder block |
| `inheritedContext` | Reconstructed ordinary history, not an inheritance marker |
| `compactionSummary` | Untrusted observation introduced as `Earlier conversation:` |
| `compactionRestoredState` | Recompiled ordinary facts; restoration mechanics remain private |
| `compactionInstructions` | Application instruction after Host validation |
| `toolCallArguments` | Native reconstructed tool arguments, never reminder prose |

### Projection rules

1. **Inclusion:** every visible sentence passes the inclusion test. Canonical
   payload kind remains diagnostic provenance, not model language.
2. **Semantic identity:** readable names accompany actionable public references at
   first use.
3. **No UI mirroring:** project what the user is attending to and what the Agent
   can act on, not the component tree needed to render it.
4. **Truth before convenience:** an unavailable view emits no current-view text
   rather than a guessed or synthetic target.
5. **Dense baseline:** combine related facts into one sentence or compact list. Do
   not make one bullet per source field.
6. **Semantic delta:** later Turns state the changed fact and resulting state. They
   never expose `snapshot`, `delta`, tombstone, or reducer mechanics.
7. **Explicit invalidation:** when a prior actionable target, non-empty selection,
   Skill, Role, or Thread instruction disappears, emit one clear removal statement.
8. **Default omission:** omit false/default/empty values unless absence invalidates
   prior model-visible state.
9. **Single ownership:** local time explains "today"; the current-view sentence
   owns the viewed target; user/tool history owns task text; the stable prompt owns
   routing rules; the supplied-resource statement owns resource content.
10. **Trust preservation:** grouping never raises authority. Mixed
    sentences use the least-trusted constituent; facts that must retain distinct
    authority use adjacent context children.
11. **Loss signaling:** truncation appears only where it changes completeness,
    such as `Visible excerpt: 80 of 126 nodes`; internal byte limits stay private.
12. **Additional-context admission:** producers declare authority and purpose
    independently from authored text and supply self-contained text plus readable
    scope. Admission validates the allowed pair; it never infers trust or purpose
    from prose. Invalid entries remain canonical diagnostics and produce no
    model-visible evidence.

### Projection lifecycle

1. On the first Turn in an epoch, compile one complete baseline from the
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
| Reminder boundary | `<system-reminder>`<br>`<context-evidence kind="turnEnvironment" authority="application" purpose="observation">`<br>`accepted_at=2026-09-01T03:14:11.592Z`<br>`...`<br>`</context-evidence>`<br>`</system-reminder>` | `<system-reminder>`<br>`<context authority="application" purpose="observation">`<br>`Local time: 2026-09-01T11:14:11+08:00 [Asia/Shanghai].`<br>`</context>`<br>`</system-reminder>` | Keep the meaningful reminder/trust boundary; use one neutral child and remove source classification from model syntax. |
| Model-visible `kind` | `kind="turnEnvironment"`, `kind="userView"`, `kind="skillCatalog"`, `kind="skillInvocation"`, `kind="compactionSummary"` | Removed; canonical source kind remains only in persistence and diagnostics | The model needs trust and purpose, not a second type system mirroring implementation sources. |
| Environment time | `accepted_at={{utcInstant}}`<br>`local_date={{localDate}}`<br>`local_time={{localTime}}`<br>`timezone={{timeZone}}`<br>`utc_offset_minutes={{utcOffsetMinutes}}`<br>`locale={{locale}}` | `Local time: {{localDate}}T{{localTime}}{{utcOffset}} [{{timeZone}}].` | One ISO-like local timestamp preserves the current offset and IANA zone. Accepted time and locale remain canonical. |
| Runtime | `working_directory={{workingDirectory}}`<br>`conversation_mode={{conversationMode}}`<br>`execution_mode={{executionMode}}` | `Runtime: {{runtimeDescription}} in {{workingDirectory}}.` | Raw enums are deterministically translated, for example to `interactive primary-Agent session`. |
| Today | `today_node_id={{todayNodeId}}`<br>`today_node_title={{todayNodeTitle}}` | Host-private; no routine model output | Local date explains "today"; Outline exposes `@today`; a viewed or referenced Today Node follows ordinary Node grammar. |
| Reply identity | `reply_identity={{replyIdentity}}` | Removed from reminder body; stable prompt owns `You are {{replyIdentity}} ...` | The model receives one persona authority. |
| Outliner attention | `panel={{panelId}} root_node_id={{rootNodeId}} root_type={{rootType}} order={{order}} active={{active}} focused={{focused}}`<br>`breadcrumb_node_id={{breadcrumbNodeId}}`<br>`node_id={{nodeId}} title={{nodeTitle}}` | `Viewing "{{rootTitle}}" {{rootNodeReference}} at {{breadcrumbTitles}}.`<br>`{{?visibleOutlineExcerpt}}` | The sentence identifies the current view directly; no classification label is needed. |
| Node-bound file preview | Currently reduced to the owning `root_node_id={{ownerNodeId}}`; preview kind and target are lost | `Viewing file "{{fileLabel}}" {{fileReference}}, opened from "{{ownerNodeTitle}}" {{ownerNodeReference}}.` | The file is the viewed object; the Node is provenance, not a substitute target. |
| Loose local-file preview | No panel output | `Viewing file "{{fileLabel}}" {{fileReference}}.` | Previously invisible attention becomes truthful and actionable. |
| URL preview | No panel output | `Viewing {{url}}.` | The URL itself is the usable semantic identity. |
| Asset preview | No panel output | `Viewing asset "{{assetLabel}}". {{?ownerNodeSentence}} {{?contentAvailabilitySentence}}` | Do not expose private `assetId`; state only identity, usable owner, and actual content availability. |
| Linked-file preview | No panel output | `Viewing linked file "{{fileLabel}}"{{?usableFileReference}}. {{?ownerNodeSentence}}` | Do not expose private `sourceValueId`; include a usable source only when an Agent capability accepts it. |
| Thread trajectory | No panel output | `Viewing trajectory for Thread "{{threadName}}" (thread ID {{threadId}}). {{?selectedRecordDescription}}` | Thread identity is actionable; private renderer record identity is not. |
| Multiple views | Repeated `panel={{panelId}} ... order={{order}} active={{active}}` records | `Viewing {{primaryTargetSentence}}`<br>`Other open views, left to right: {{otherTargetDescriptions}}.` | Preserve only spatial semantics needed for cross-view references. |
| Focus on primary root | `focused_node_id={{rootNodeId}}`<br>`focus_surface=row` | Removed | It repeats the primary target and changes no decision. |
| Distinct focus | `focused_node_id={{focusedNodeId}}`<br>`focus_surface={{focusSurface}}` | `Focused node: "{{focusedNodeTitle}}" {{focusedNodeReference}}.`<br>or `Insertion target: children of "{{parentTitle}}" {{parentReference}}.` | A concrete referent or action replaces an internal surface name. |
| Initial empty selection | `selected_node_ids=none` | Removed | Empty default state does not pass the inclusion test. |
| Non-empty Node selection | `selected_node_ids={{selectedNodeIds}}` plus detached title records | `Selected: {{selectedNodeReferences}}.` | Each selection is readable and actionable. |
| Selection cleared | `selected_node_ids=none` in a delta | `Selection cleared.` | Absence is relevant only because it invalidates prior visible state. |
| Visible outline | Repeated `visible_node_id={{nodeId}} depth={{depth}} focused={{focused}} collapsed={{collapsed}} child_count={{childCount}}` | `Visible outline:`<br>`{{boundedOutlineMarkup}}`<br>`{{?truncationSentence}}` | Referable content uses outline grammar; empty or root-only content emits nothing. |
| Explicit Node references | `explicit_reference_ids={{nodeIds}}` plus detached title records | Merged into the current-view or supplied-resource sentence only when User input does not already own them | Prevent duplicate references while preserving user deixis. |
| Attention change | `active_panel_id=none`<br>`panel_closed={{panelId}} root_node_id={{closedRootNodeId}}` | `Closed "{{closedTargetTitle}}" {{?closedTargetReference}}. {{?remainingAttentionSentence}}` | Emit the invalidated identity and resulting state, not a tombstone. |
| No real user view | Main synthesizes `panel=today root_node_id={{todayNodeId}}` | No current-view sentence | Environment state must not masquerade as user attention. |
| Scoped instruction | `key={{key}} source={{source}} lifetime={{lifetime}} state={{state}}` plus authored text | `Scope: {{scopeDescription}}.`<br>`{{authoredText}}` | The application/instruction wrapper supplies the protocol meaning; readable scope remains and state-machine metadata stays private. |
| Additional context | Every entry projects under `kind="additionalContext"` with internal key/source markers | Self-contained text under its Host-admitted authority/purpose pair; invalid entries remain Host-private | Intake source and internal routing state no longer become model categories. |
| Referenced material | Separate identity, title, breadcrumb, path, availability, snapshot, and media fragments | `"{{resourceTitle}}" {{usableReference}}`<br>`{{?boundedContentOrMedia}}`<br>`{{?exceptionalAvailability}}` | One statement owns identity, content, and availability without requiring a `material` type. |
| Skill availability | `mode={{catalogMode}}`<br>`- name={{skillName}} change={{catalogChange}} description={{skillDescription}}`<br>`{{repeatedRoutingRule}}` | `Available Skills:`<br>`{{skillEntries}}` | Discovery is an application observation; reducer state and repeated policy disappear. |
| Role availability | `mode={{catalogMode}}`<br>`- name={{roleName}} change={{catalogChange}} description={{roleDescription}}`<br>`{{repeatedRoutingRule}}` | `Available Roles:`<br>`{{roleEntries}}` | Role discovery follows the same observation grammar. |
| Skill invocation | `name={{skillName}}`<br>`execution={{execution}}`<br>`allowed_tools={{allowedTools}}`<br>`model={{modelOverride}}`<br>`effort={{effortOverride}}`<br>`{{skillInstructions}}`<br>`field=arguments`<br>`{{taskArguments}}` | `Active Skill: {{skillName}}.`<br>`{{skillInstructions}}`<br>`{{?nonDefaultSkillConstraints}}` | Only actual instructions use application/instruction; defaults and task text already in history disappear. |
| Compaction/restoration | `source=deterministic`<br>`lossy_derived_context=true`<br>`restored_after_compaction=true`<br>`checkpoint={{hash}}` | `Earlier conversation:`<br>`{{summary}}` plus ordinary recompiled current facts | Preserve meaning under ordinary observation/instruction wrappers, not compaction mechanics. |
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
language rather than only the template. Each row is an untrusted observation
body; the wrapper is omitted here only to keep the examples focused.

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
| Headless or missing renderer hints | No current-view sentence. |

### Historical field disposition

A historical field does not receive a new standalone label merely because it
existed before.

| Historical field or fragment | Disposition | New owner or rationale |
| --- | --- | --- |
| Canonical payload `kind` in the model-visible wrapper | Removed; retained in persistence and diagnostics | Authority and purpose are the complete model-visible protocol; audit retains exact source provenance. |
| `projection_mode={{projectionMode}}` | Removed from model text; host-private | Semantic baseline/change language replaces reducer mechanics. |
| `accepted_at={{utcInstant}}` | Removed from reminder body; host-private | Canonical admission and provider message time already own it. |
| `local_date`, `local_time`, `timezone`, `utc_offset_minutes` | Merged | Produces one application-observation `Local time` sentence. |
| `locale` | Removed from routine model text; host-private | The ISO timestamp is unambiguous and user language is stronger evidence than renderer locale. |
| `working_directory`, `conversation_mode`, `execution_mode` | Merged | Produces one application-observation `Runtime` sentence. |
| `reply_identity` | Removed from reminder body; host-private | Stable system prompt owns the persona. |
| `today_node_id`, `today_node_title` | Removed from routine model text; host-private | Local date, `@today`, ordinary attention, and explicit references own the useful meanings. |
| `active_panel_id`, `focused_panel_id`, `panel_id` | Removed from model text; host-private | Renderer correlation IDs are not Agent targets. |
| `PanelView.kind` | Replaced by canonical attention target kind | It determines sentence grammar but never appears as a raw UI enum. |
| `root_node_id` plus resolved title | Merged into Node attention target | Produces a title and public Node reference. |
| `root_type` | Removed from model text; host-private | Node product class does not alter generic attention grammar. |
| `PreviewTarget.kind` and target data | Merged into file/asset/linked-file/URL attention target | Preserve viewed object identity without leaking private IDs. |
| `threadId`, `turnId`, `selectedRecordId` from trajectory | Partially merged into trajectory attention | Actionable Thread identity and semantic selection remain; private record identity stays host-private. |
| `order`, `active`, `focused` flags | Merged into the current-view sentence only when spatial relation changes interpretation | Raw booleans never appear. |
| Repeated breadcrumb IDs and detached title records | Merged into the current-view sentence | Produces one readable path. |
| `focused_node_id` plus resolved title | Merged into optional focus text | Omitted when redundant; otherwise a titled public reference. |
| `focus_surface` | Removed or translated into an optional actionable relation | Known actionable relations become prose; unknown names stay private. |
| `selected_node_ids` plus resolved titles | Merged into current-view text when non-empty or cleared | Initial empty selection disappears. |
| `explicit_reference_ids` plus resolved titles | Merged into the first applicable owner | Avoid duplication across User input, current-view text, and supplied-resource text. |
| Repeated visible-node fields | Merged into an optional current-view excerpt | Produces bounded outline content; empty/root-only projections disappear. |
| False truncation flags | Removed from model text | Complete is the default. |
| True truncation flags | Merged into the affected sentence group | Produces one partial statement without byte-limit details. |
| Panel close tombstone | Merged into a current-view change sentence | Produces closed-target identity and resulting attention state. |
| Catalog modes, hashes, identities, source records | Removed from model text; host-private | Reducers, audit, and restoration own them. |
| Catalog entry identity, description, meaningful change | Merged into capability availability text | Produces available/added/updated/removed Skill or Role entries. |
| Repeated Skill/Role routing sentences | Removed from catalog blocks | Stable prompt owns routing policy. |
| Skill invocation name and validated instructions | Merged into an application-instruction child | Produces one active Skill instruction block. |
| Default Skill execution/model/effort/tool constraints | Removed from model text | Defaults do not change behavior. |
| Skill arguments and duplicated task text | Removed from reminder block | Canonical user input or tool call owns the task. |
| `additionalContext` as a model-visible category | Removed | Intake source never determines model meaning; each admitted entry uses only authority, purpose, scope, and text. |
| Additional-context internal keys and state markers | Removed from body; host-private | Projected content keeps readable scope, source authority, and fixed purpose. |
| Referenced-resource records | Merged into one supplied-resource statement | One sentence group holds usable identity, content, and exceptional availability. |
| Compaction implementation markers | Removed from model text; host-private | Ordinary observation/instruction bodies expose only earlier meaning and current facts. |
| Historical observation markers | Replaced by `Earlier conversation:` | Historical content keeps a readable subject and mutable-source warning. |
| Degradation code, source, reference | Removed from model text; diagnostics-private | An application observation exposes only impact and recovery. |
| Native tool definitions and JSON arguments | Unchanged | JSON Schema and JSON remain the tool-input contract. |
| Built-in visible `ToolEnvelope` | Unchanged | It is already the target model-result contract. |
| Collaboration raw result | Replaced | All model-visible tool results use `ToolEnvelope`. |

### Tool boundary consistency

Consistency means one grammar per semantic boundary, not one grammar for all data.

| Boundary | Contract |
| --- | --- |
| System/developer rules | Markdown |
| Dynamic context | `<system-reminder>` containing `<context authority="..." purpose="...">` children with readable Markdown bodies |
| User/assistant communication | Natural language plus canonical references |
| Tool definitions and arguments | JSON Schema and JSON |
| Tool results | Compact JSON `ToolEnvelope`, followed by native media parts |
| Persistence/diagnostics | Typed canonical payloads, never inferred from model prose |

All built-in and collaboration tool results use the same visible states: success,
unchanged, partial, denied, and error. `ok` is sufficient for success/failure;
empty fields and synonymous status strings are omitted. Durable internal details
remain host-private and are not required to parse the model-visible result.

### Requirements

- **FR-1:** a Turn-brief compiler applies the inclusion test to every current
  context payload instead of serializing its fields directly.
- **FR-2:** `<system-reminder>` remains the outer boundary and its children use
  only `<context authority="..." purpose="...">`. Escaping, ordering, and
  provenance behavior remain intact; diagnostics separately retain canonical
  source kind.
- **FR-3:** canonical renderer-to-main evidence distinguishes every supported
  attention target: Outliner Node, local file, asset, linked file, URL, and Thread
  trajectory.
- **FR-4:** current-view text names the primary real target and up to the other
  three current workspace targets using readable, actionable identities without
  panel IDs or detached title maps.
- **FR-5:** distinct focus, non-empty selection, selection clearing, and bounded
  excerpts appear only when they change interpretation or action. Empty defaults
  and raw focus surfaces never appear.
- **FR-6:** Today Node metadata remains canonical but does not receive routine
  model output or synthesize attention when no renderer view exists.
- **FR-7:** viewed resource identity and supplied resource content remain separate;
  a current-view sentence never implies that unseen bytes were provided.
- **FR-8:** stable prompt, catalog, invocation, and user/tool history each own one
  distinct Skill/Role responsibility and never repeat task text.
- **FR-9:** compaction and restoration re-emit ordinary current facts under the
  same authority/purpose contract; only an actionable recovery statement exposes
  degradation.
- **FR-10:** built-in and collaboration tools expose the same compact result
  envelope while retaining full durable details privately.
- **FR-11:** every additional-context entry records Host-admitted authority,
  purpose, readable scope, and self-contained text. Only the three documented
  authority/purpose pairs project; invalid entries remain host-private.
- **NFR-1:** projection is byte-deterministic across replay, restart, fork,
  steering, reset, and compaction.
- **NFR-2:** every projected sentence records its inclusion rationale in fixtures,
  and the complete representative fixture has fewer characters and estimated
  tokens than before.

### Acceptance criteria

- **AC-1 (FR-1):** an exhaustive test maps every canonical context payload kind to
  application observation, untrusted observation, application instruction, or an
  explicit host-private/native-tool destination.
- **AC-2 (FR-2):** exact fixtures contain no `kind` attribute or canonical payload
  kind in a routine model-visible wrapper.
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
  and missing-renderer fixtures contain no current-view sentence.
- **AC-6 (FR-7):** identity-only asset and linked-file fixtures state actual
  content availability and contain no private `assetId` or `sourceValueId`.
  Supplied text appears only in an untrusted observation and images retain native
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
  retained fact has an inclusion rationale and unexplained regressions fail the
  test.
- **AC-12:** typecheck, focused Core and renderer tests, full relevant test suites,
  and `docs:check` pass; current behavior is folded into owning specifications.
- **AC-13 (FR-11):** a matrix test accepts exactly application/observation,
  untrusted/observation, and application/instruction. Untrusted/instruction,
  missing metadata, and authored-text spoofing fixtures prove that prose cannot
  change trust or purpose and that invalid entries do not project.

### Execution units

**Feature A - Turn brief and attention contract**

- Order this PR after #609 and #610, rebase, and repeat the open-claim/file-scope
  collision check before editing Skill and shared protocol surfaces.
- Extend the renderer-to-main canonical contract and codec with the semantic target
  union; preserve host-private panel correlation and reject no user Turn merely
  because one target cannot be resolved.
- Remove model-visible `kind`, retain canonical source kind in diagnostics, and
  define the three admitted authority/purpose pairs once in the stable prompt.
- Capture all `PanelView` variants, remove Today-based synthetic panels, and retain
  honest no-view state.
- Add a pure brief planning/formatting layer before XML escaping and route all
  context payload kinds through the inclusion test.
- Extend direct and extension additional-context admission with Host-validated
  authority, purpose, readable scope, and self-contained text; keep invalid
  entries diagnostics-only.
- Add exact whole-block fixtures, forbidden-token assertions, meaning-based delta
  tests, panel coverage tests, behavior checks, and density measurements.
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
pure Turn-brief module, `stablePrompt`, Skill/Role projection, compaction
projection, and focused Core/renderer fixtures. Feature B likely touches
`agentToolEnvelope`, collaboration result adapters, tests, and owning specs.

## Open questions

None. DEC-1 through DEC-4 are the proposed review decisions; implementation starts
only after PM ratification.
