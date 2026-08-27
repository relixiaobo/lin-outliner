# Reference URI Unification

**Shape:** (a) ONE complete protocol refactor in one PR before #584,
#587, `agent-result-and-file-lifecycle`, and `agent-cross-thread-reference`
continue. The URI codec, Node/file marker cutover, every producer and consumer,
provider guidance, renderer behavior, tests, and current specifications land
together. No dual grammar ships.

## Goal

Give Tenon one clean textual locator for every user/model-visible canonical
reference. `[[...]]` identifies an interactive Tenon reference; its complete
inner value is a URI:

```text
[[node://550e8400-e29b-41d4-a716-446655440000]]
[[file:///Users/me/Documents/Quarterly%20Review.pptx]]
[[thread://01951d6e-7c25-7c31-8d62-313038616239]]
```

The first PR admits `node` and `file`; the later cross-Thread feature adds
`thread` through the same codec. The URI contains identity or location only.
Display names are derived presentation and never alter reference resolution.

This replaces the custom `[[kind:label^value]]` wire grammar, the separate
`file:^path` pseudo-URL, and their duplicated label/path parsing rules. Canonical
product state remains structured data; the URI is its plain-text transport and
citation form.

## Non-goals

- No conversion of every string containing `://` into a Tenon reference.
- No change to ordinary `https:` links, Markdown link syntax, or OS URL opening.
- No change to bracket-tag syntax such as `[[#tag]]` or `#[[multi word tag]]`.
- No unification with `%%node:id%%` annotated-outline edit handles. Those are
  mutation protocol metadata, not references in user prose.
- No exposure of ContentStore digests, retention anchors, Host-private resource
  IDs, cursors, or database keys as reference URIs.
- No interpretation of `asset://` and `preview-local://` transport URLs as
  canonical marker schemes. Their existing Electron protocol handlers serve
  bytes or scoped previews; they grant no general reference authority.
- No use of a URI or syntactically valid marker as permission. Every consumer
  continues to resolve through its domain authority and action checks.
- No label parameter, query field, fragment, alternate marker form, or hidden
  identity inside display text.
- No migration, legacy parser, dual writer, compatibility decoder, or automatic
  startup deletion. Stopped-process userData is manually reset before cutover
  verification.

## Design

### Requirements

- **FR-1:** Parse and format one marker shape: outer `[[...]]` brackets around
  one absolute reference URI.
- **FR-2:** Encode ordinary referenceable Nodes as `node://UUID`, the explicit
  referenceable system-Node allowlist as `node://PUBLIC-KEY`, and absolute local
  files as standard `file:` URLs. The URI scheme replaces the internal `node:`
  namespace prefix rather than duplicating it.
- **FR-3:** Accept Unicode IRI input where the URL parser permits it and emit one
  canonical percent-encoded URI representation.
- **FR-4:** Resolve display text independently: current Node title for `node`,
  decoded basename for `file`, and a short safe locator only when metadata is
  unavailable.
- **FR-5:** Preserve structured `ReferenceTarget` values in canonical rich text,
  Composer content, tool records, and renderer state. Parse textual URIs only at
  explicit plain-text boundaries.
- **FR-6:** Keep one lexical `[[...]]` scanner and one URI codec. Consumers use
  explicit allowlists, so admitting a future `thread` scheme for Agent content
  does not make it a valid Outline inline reference.
- **FR-7:** Replace every Node/file marker producer, parser, provider prompt,
  annotated tool grammar, paste/import/export path, Markdown renderer, editor
  round trip, and test fixture in the same change.
- **FR-8:** Preserve explicit escaping: `\[[node://...]]` and
  `\[[file:///...]]` remain literal text at boundaries that currently support
  marker escape.
- **FR-9:** Treat malformed, relative, unsupported, or consumer-disallowed URIs
  as ordinary text or a typed non-fatal unavailable reference according to the
  existing boundary. They never fall back to guessed identity.
- **NFR-1:** URI parsing and formatting are deterministic across Electron main,
  renderer, Outliner Runtime, tests, and supported macOS file paths.
- **NFR-2:** The cutover introduces no filesystem access, browser navigation, or
  authorization side effect in the pure codec.

### Decisions And Constraints

- **DEC-1:** `[[...]]` is a reference marker, and the entire inner value is a
  canonical URI. It is not a second mini-language around a URI.
- **DEC-2:** Labels do not serialize. UI surfaces resolve them at render time;
  model/tool projections place a readable name adjacent to the marker when the
  surrounding plain-text grammar needs one. The URI itself remains copyable and
  unchanged.
- **DEC-3:** `node://UUID` maps explicitly to the internal `node:UUID` storage ID
  at the codec boundary; the internal prefix never serializes or participates
  twice. The only non-UUID Node authorities are stable public keys for system
  Nodes that the current product already permits users to reference:
  `workspace`, `daily-notes`, `library`, `schema`, and `searches`. The codec maps
  those keys explicitly and rejects every other internal ID. One Core-owned
  public-Node-ID predicate governs marker producers, decoders, and candidate
  admission so the allowlist cannot drift. `thread` remains a canonical lowercase
  UUID scheme. Scheme and UUID case are canonicalized, and no arbitrary internal
  ID is accepted by fallback. Public keys are stable protocol identifiers, not
  localized titles.
- **DEC-4:** `file` follows standard absolute file-URL rules. POSIX paths use an
  empty authority (`file:///...`), spaces and Unicode serialize through standard
  URL percent encoding, and a trailing slash carries directory intent when the
  source is not stat-able.
- **DEC-5:** URI parsing establishes a locator only. Node existence/Trash checks,
  filesystem working-set/root admission, symlink and opened-file identity,
  renderer Preview/Open, and action capability remain separate resolution
  boundaries.
- **DEC-6:** The codec is compile-time extensible through explicit scheme
  decoders, not a runtime registry. Unknown schemes stay plain text until one
  coordinated feature admits them.
- **DEC-7:** `asset://abc123` and `preview-local://550e8400-e29b-41d4-a716-446655440000`
  keep their current
  transport semantics and builders. They may pass through generic URL utilities,
  but they are never accepted by marker consumers in this PR.
- **CON-1:** Current ordinary referenceable Node IDs use `node:UUIDv4`
  internally. The public URI deliberately strips and reconstructs only that
  validated prefix. Current system content targets use the explicit public keys
  above because the existing reference picker admits those Nodes. `trash`,
  `recents`, built-in `tag:*` definitions, `schema:*` option trees, `sys:*`
  operands, generated `*::cfg:*` records, and every other structural/internal ID
  remain non-marker protocol data. A future referenceable system Node or public
  object kind requires an explicit codec addition instead of passing an
  arbitrary internal string through `node://`.
- **CON-2:** Thread IDs are lowercase UUIDv7 values and are URL-safe, but the
  `thread` scheme is reserved until `agent-cross-thread-reference` implements its
  canonical resolver and bounded read semantics.
- **CON-3:** File paths in Agent output are not canonical authority. The later
  lifecycle plan binds a sealed file URI to a Host-private resource reference
  and independently resolves source or exact revision.

### 1. URI Families And Boundaries

| Value family | Example | Marker-admitted | Authority |
| --- | --- | --- | --- |
| Ordinary Node reference | `node://550e8400-e29b-41d4-a716-446655440000` | Yes | Outline document/Core |
| Referenceable system Node | `node://library` | Yes, explicit allowlist only | Outline document/Core |
| Local file locator | `file:///Users/me/report.pdf` | Yes | Host working set and admitted roots |
| Historical Thread reference | `thread://019...` | Reserved in this PR; admitted by the later feature | Agent canonical Thread store and active profile |
| Outline asset transport | `asset://abc123` | No | `AssetService` protocol handler |
| Scoped preview transport | `preview-local://token` | No | Main-issued capability and preview handler |
| External web URL | `https://example.com` | No; use ordinary Markdown links | Web/navigation policy |
| Content revision/digest/anchor | Host-private | Never | ContentStore and domain record |
| Annotated edit handle | `%%node:id%%` | Not a URI | Node tool mutation grammar |
| Bracket tag | `[[#tag]]` | Not a URI | Text/tag grammar |

Syntax similarity never collapses these authority boundaries.

### 2. Shared Codec

`referenceMarkup.ts` keeps the one non-overlapping bracket scan but delegates
the inner string to a pure reference-URI codec. The codec returns a lexical URI
record first; consumer decoders then produce supported structured targets.

Conceptually:

```ts
type ReferenceUri =
  | { readonly scheme: 'node'; readonly nodeId: string }
  | { readonly scheme: 'file'; readonly path: string; readonly entryKind: 'file' | 'directory' }
  | { readonly scheme: 'thread'; readonly threadId: string };

parseReferenceMarker(text, admittedSchemes)
formatReferenceMarker(referenceUri)
```

The shape is design authority, not a requirement to expose one application-wide
logical resource union. Outline `ReferenceTarget` remains `node | local-file`;
Agent Thread content later uses its own structured `threadReference` type.

The parser must reject relative values, credentials, query/fragment additions,
unexpected path components, malformed percent encoding, empty identities, and
scheme-specific non-canonical forms. In particular, `node://node%3AUUID`,
`node:///UUID`, unknown system keys, and percent-encoded arbitrary internal IDs
are invalid rather than aliases. Parsing never stats a path, reads a Node, or
opens a Thread.

### 3. Presentation Without Serialized Labels

Display is a resolver concern:

- a Node chip shows the current Node title, then a shortened decoded Node ID if
  unavailable;
- a file chip shows the decoded basename, then the normalized file URL;
- the later Thread chip shows the current Thread title, then a shortened UUID;
  and
- copied reference identity remains the exact URI regardless of displayed text.

Canonical structured content may retain presentation metadata already required
for offline UI, but that metadata is not serialized into the URI and is never
used for equality. When plain provider/tool text would otherwise become opaque,
the projector emits readable ordinary text beside the URI, for example:

```text
Status field: [[node://550e8400-e29b-41d4-a716-446655440000]]
Quarterly Review.pptx: [[file:///Users/me/Documents/Quarterly%20Review.pptx]]
```

This keeps model context understandable without putting mutable names into the
locator.

### FLOW-1: Round-Trip A Canonical Reference

- **Actor:** A user or Agent creating plain text that refers to a Node or file.
- **Entry path:** Composer mention, editor/paste/import, Node tool output/input,
  provider projection, or terminal Agent text.
- **Entry state:** The producer holds a structured target or an absolute admitted
  URI.
- **Goal:** Preserve one unambiguous reference across text and structured forms.
- **Mainline:**
  1. Format the structured target as a canonical URI marker.
  2. Persist or transport the plain text unchanged where text is the contract.
  3. Scan the bracket marker once and decode the URI under the consumer allowlist.
  4. Resolve identity/location through the owning domain.
  5. Render the resolved display name without rewriting the URI.
- **Decision points:** Unsupported scheme and invalid URI remain text; supported
  but unavailable targets render the existing unavailable behavior.
- **Validation:** Canonical URI syntax, admitted scheme, decoded value shape, and
  domain-specific existence/access checks.
- **Result state:** Structured equality depends only on the decoded target; the
  display may change without changing identity.
- **Failure/recovery:** A codec failure is local to the marker and never crashes
  the containing paste, message, preview, or Turn unless the existing write
  boundary deliberately rejects an invalid required reference.
- **Requirements:** FR-1 through FR-9, NFR-1, NFR-2.

### 4. Implementation Surface And Collision Result

The complete cutover touches `referenceMarkup.ts`, `ReferenceTarget` consumers,
Markdown/rich-text conversion, semantic ingest, editor and paste paths, Agent
Composer projection, Node tool grammar/guidance, file/image inputs, Preview/Open
routing, fixtures and snapshots, and every current spec that names the old
grammar. `formatLocalFileReferenceUrl` and `parseLocalFileReferenceUrl` collapse
into the same standard file-URI codec instead of surviving as a second format.

Collision check on 2026-08-26: PR #584 overlaps Agent tools, file/resource
handling, runtime specifications, and broad fixtures. PR #587 overlaps Composer
content, history, editor, and specifications. This foundation lands first; both
PRs return to Draft as needed, rebase on it, and rerun exact file-scope checks
before continuing.

### 5. Sequencing And Verification

The dependency order is fixed:

1. Merge this plan authority.
2. Implement this URI cutover as one complete refactor PR.
3. Rebase and finish #584 on the canonical URI grammar.
4. Rebase and finish #587 without preserving or emitting the retired grammar.
5. Implement `agent-result-and-file-lifecycle` over canonical file URIs.
6. Implement `agent-cross-thread-reference` by admitting canonical Thread URIs.

Verification includes:

- parse/format round trips for canonical Node UUIDs, each admitted system-Node
  public key, and POSIX files/directories containing spaces, Unicode, `]`, `#`,
  `?`, `%`, and malformed percent encoding;
- IRI input to canonical URI output;
- empty, relative, credential-bearing, query/fragment, unknown-scheme, and
  consumer-disallowed forms;
- literal escaping and adjacent/multiple markers;
- Node/file rich-text, plain Markdown, paste, import/export, Composer,
  provider/tool, and final-response round trips;
- current-title/basename rendering, unavailable fallbacks, rename behavior, and
  copy identity;
- Node/Trash and file working-set/security checks proving URI syntax grants
  nothing;
- guards proving `node://node%3A...`, unknown system keys, `trash`, `recents`,
  `tag:*`, `schema:*`, `sys:*`, and generated config IDs cannot enter markers;
- guards showing `asset`, `preview-local`, Thread, digest, anchor, and private
  resource IDs are not accidentally marker-admitted; and
- source/dependency guards proving the old `kind:label^value`, `file:^path`,
  label sanitizer, alternate parser, and dual writer are absent.

The implementation updates current `docs/spec/` authority in the same change and
runs `bun run typecheck`, complete Core and renderer suites, relevant E2E suites,
`bun run docs:check`, and `git diff --check`.

## Open questions

None. URI-only identity, label-free serialization, scheme boundaries, standard
file URLs, percent encoding, consumer allowlists, clean cut, and dependency order
are fixed. A future app-wide deep-link protocol is separate: reference URIs may
be routed by the Host, but this PR does not register Node/file schemes with the
OS or browser.

## Acceptance Criteria

- **AC-1:** Every emitted Node/file marker wraps exactly one canonical URI in
  `[[...]]`; no emitted text uses `label^value` or `file:^path`.
- **AC-2:** Renaming a Node or changing presentation metadata changes rendered
  text but not the URI, equality, copied locator, or target.
- **AC-3:** Unicode and reserved characters round-trip through standards-based
  URL encoding without delimiter ambiguity or lossy decoding.
- **AC-4:** A valid Node/file URI resolves only after the existing domain and
  action checks; a raw URI never grants Node visibility or filesystem access.
- **AC-5:** Unknown and disallowed schemes remain ordinary text. In particular,
  `thread`, `asset`, and `preview-local` are not admitted by this PR.
- **AC-6:** Model/tool context remains readable through adjacent resolved names,
  while names never enter URI identity.
- **AC-7:** Structured references remain canonical application state. Re-parsing
  arbitrary prose is not required to preserve Composer/editor references.
- **AC-8:** After the manual clean reset, no runtime reader, writer, prompt,
  fixture, or current specification retains the retired reference grammar.
- **AC-9:** Ordinary internal `node:UUID` IDs serialize with exactly one `node`
  discriminator as `node://UUID`; the five admitted system Nodes round-trip
  through their explicit public keys, and no other internal Node ID is guessed,
  percent-encoded, or exposed through the marker codec.

## Implementation Checklist

- [ ] Add the strict reference-URI codec and convert the shared bracket scanner.
- [ ] Cut over Node/file formatters, parsers, structured conversions, editors,
  paste/import/export, providers, tools, previews, and final-text consumers.
- [ ] Replace serialized labels with resolver display and adjacent provider/tool
  descriptions where semantic readability requires them.
- [ ] Delete old grammar helpers and dual-format guidance; add source guards.
- [ ] Update current specs and exhaustive tests, manually reset stopped-process
  stores, verify fresh data, and run all plan-required checks.
