# Agent Skills

Lin implements agent skills as local `SKILL.md` instruction bundles that the model can discover, invoke, and carry across compaction. The execution path is integrated through `pi-agent-core`.

## Search Paths

`built-in` skills load first. They are immutable, ship with the app, and cannot
be shadowed by mutable local skills with the same name. Resource-backed
built-in skill folders load before code-registered inline built-ins; a duplicate
built-in name is a product bug and fails loudly instead of being silently
dropped. The current user-visible built-in skills are `/skillify`, `/research`,
and `/data-cleanup`.
`issue-planning` is a model-only built-in workflow and is not exposed as a slash
skill.

`/skillify` is a user- and model-invocable workflow for creating or updating
local skills through normal file tools. Its Skillify v2 body analyzes the current
conversation, chooses a Tenon skill path, drafts a complete `SKILL.md` or focused
update diff, and writes directly when the explicit request and conversation
determine the contract. It asks only for a missing identity, storage target,
trigger, or behavior choice that cannot be inferred. Its `when_to_use` gates it
to explicit user save/update requests, so a conversational "save this as a
skill" routes through curated guidance instead of ad-hoc file writes. The
runtime also treats explicit natural-language authoring requests such as "save
this as a skill" or "update the import skill with this workflow" as direct
`/skillify` user invocations when slash skills are enabled; ordinary questions
about whether a skill exists or how skills work remain normal conversation.

`issue-planning` is a model-invocable guidance workflow for turning a
natural-language durable-work request into one or more verified Issues. It tells
the model to choose Issue boundaries from independently user-visible outcomes,
author the durable objective/scope/criteria/output/trigger/verification
definition, encode per-item coverage as criteria or description text, leave
execution sequencing and short-lived subtasks to the later Agent Session, and
create a child Issue only when a sub-outcome needs its own durable lifecycle or
independent Agent Session. Runtime derives child parentage from the creating
Session and routes child completion, cancellation, or Session error back one hop
without exposing routing origins to the model. The workflow uses relations only
between independently managed Issues and relies on Issue criteria, Activity, and
verifier evidence rather than one Session's own completion claim.
It also separates interaction mode: direct one-turn work should be answered
directly, durable work should be handed off through runtime-triggered background
execution, and `agent_session_read(wait)` is reserved for an explicit wait on an
existing Session. There is no user-facing `/issue-planning` or `/goal` shortcut,
and no composer goal button; ordinary prose is the entry point.

`/research` is a user- and model-invocable `execution: isolated` workflow for
bounded investigation. It starts an isolated same-agent Run and
uses an internal built-in-only read-only
isolated-execution flag, so the sub-run receives the inherited conversation context
but a narrowed read-only tool catalog. Its prompt tracks
cc-2.1 Explore's research loop: strict no-modification framing, broad-to-narrow
codebase search, explicit file/nodes/read tool selection, caller-scaled
thoroughness (`quick`, `medium`, `very thorough`), parallel independent
read/search calls, and a compact evidence-backed report.

`/data-cleanup` is a user- and model-invocable resource-backed workflow for
cleaning external note/data exports into Tenon's import shape before any
document write. It is source-agnostic at the skill level: the model profiles the
source, explains fidelity tradeoffs, and runs deterministic scripts for known
formats. It infers destination and
fidelity from the request and asks only when a material choice remains
unresolved. Supported write routes emit
Import Pack v1, validate schema and coverage, generate a compact preview with
`tenon-import preview`, and run `tenon-import commit` with the returned preview
id without a second confirmation when the original request authorized import.
Tana JSON is the first deterministic write route. Roam
EDN backups are currently profile-only: the skill can inspect counts and
samples, but must not write Roam data until a deterministic Roam adapter emits a
valid Import Pack.

`/data-analysis`, `/document`, `/feed-processing`, `/pdf`, `/presentation`, and
`/spreadsheet` are optional Linlab-recommended managed skills. They do not ship
in the app bundle. A user installs them from the remotely refreshed Linlab
Catalog, reviews the immutable GitHub commit, and enables them separately. They
are goal-oriented skills rather than file-extension adapters:

- `/presentation` covers slide decks, talks, PPTX inspection, browser HTML
  decks, PDF handouts, speaker outlines, deck verification, and opinionated
  visual deck construction. Its visual route requires a design direction, theme,
  motif, and registered layout recipes before generation. It includes a modern
  Keynote-style stage direction and default HTML template for premium product,
  launch, and executive decks, then uses the HTML inspector to report layout
  variety, text-only slide, bullet density, tiny text, placeholder, dependency,
  and asset-reference risks.
- `/document` covers professional written documents, archetype/form-factor
  planning, DOCX inspection, Markdown drafts, review notes, comments, redlines,
  and document verification. Its portable scripts report DOCX package integrity
  plus document-semantics risks such as heading jumps, manual bullets, table
  geometry gaps, comment references, headers/footers, and notes; the Markdown
  inspector reports heading hierarchy, long paragraphs, wide tables, local
  assets, remote images, and placeholder text.
- `/pdf` covers fixed-layout PDF creation, inspection, extraction, rendering,
  OCR, form, redaction, merge/split/rotate, and verification routes. Its
  portable script reports PDF structure, pages, metadata, forms, annotations,
  extractability, and render/extraction warnings; richer host PDF tools may be
  used when available, but verification still requires structural and visual
  checks.
- `/data-analysis` covers trustworthy file/database analysis, profiling before
  trusting data, DuckDB/SQL analysis, join fan-out checks, triangulation,
  findings ledgers, house-styled charts/tables, and self-contained HTML reports.
  Its required Python dependencies are explicit in the skill's
  `requirements.txt`; the agent should install the needed tier when allowed
  instead of replacing the workflow with a lower-fidelity approximation.
- `/feed-processing` covers RSS, Atom, JSON Feed, OPML, feed URLs, page URLs,
  subscription tables, prior feed-content packs, fetch windows, source health,
  bad-feed handling, rule-based filtering, and full-text attempt ledgers. Its
  native output is a sink-neutral feed-content pack; writing that pack into
  Tenon or any other host surface remains a separate consumer workflow.
- `/spreadsheet` covers durable workbook artifacts and calculable tabular
  models: XLSX/CSV/Google Sheets-targeted workbooks, formulas, named ranges,
  validation, tables, pivots, charts, imports, exports, workbook QA, and
  source-first generation routes.

Each resource-backed skill includes its own `SKILL.md`, route-specific
references, scripts, assets, and templates. The app does not inject those
support files automatically; the skill body points the model at
`${AGENT_SKILL_DIR}` or `{baseDir}` so the agent can load or execute only the
resources relevant to the current task.

Built-ins can be either resource-backed app folders or code-registered inline
instructions. Resource-backed built-ins use the standard skill folder shape:

```text
<skill-name>/
  SKILL.md
  references/
  scripts/
  assets/
```

`bun run skills:sync` stages only Tenon-owned built-ins into
`build/generated/built-in-skills`. The Electron package copies that generated
root into `Resources/built-in-skills`, and the packaged runtime resolves that
resource path instead of depending on the current working directory. The
resource-backed platform floor is `/data-cleanup` plus the private
`memory-dream` runtime skill. The code-registered floor is `/skillify`,
`/research`, and `issue-planning`. General-purpose Linlab skills are installed
through the managed flow and never copied by `skills:sync`. Resource built-ins
only receive a `Base directory` prefix when they have real extracted reference
files. Inline built-ins such as `/skillify` and `/research` have no extracted
files, so their prompts contain only the skill body. Post-compact bookkeeping
records all built-ins as `built-in:<name>` rather than an editable file path.

Default mutable skill directories are always enabled:

- `~/.agents/skills`
- `<workspace>/.agents/skills`

Each skill is a directory with a `SKILL.md` file. Additional skill directories can be configured in Agent settings; those directories are appended after the defaults and can be absolute, workspace-relative, `~/...`, `$HOME/...`, or `${HOME}/...`.

Every skill carries one of four skill-specific sources: `built-in` (Tenon-owned,
immutable), `managed` (a validated Tenon-managed local copy pinned to GitHub),
`user` (the personal library — `~/.agents/skills` plus configured directories
outside the workspace root), and `project` (the work context —
`<workspace>/.agents/skills`, configured directories inside the root, and nested
`.agents/skills` directories discovered at runtime near touched files). This
does not extend `AgentSourceKind`; agent and skill ownership are separate
contracts. Runtime discovery is a discovery mode, not a separate source.

## Managed GitHub Skills

The Linlab Catalog is recommendation and distribution metadata, not a runtime
source. Catalog refresh uses a fixed, bounded `raw.githubusercontent.com` URL and
caches the last valid schema under private `userData`. A catalog outage may make
recommendations unavailable, but it never changes installed content, enabled
state, or offline invocation. Linlab entries are labelled **Recommended**;
arbitrary public GitHub entries are labelled **Unverified**. Neither label adds
tools, folders, permissions, or control-plane access.
Each catalog recommendation is bound to its exact repository subdirectory and
declared skill name; nested candidates never inherit the Recommended label.

The importer accepts credential-free `https://github.com/{owner}/{repo}`
repository, tree, and `SKILL.md` blob URLs. It resolves a default branch, branch,
tag, or commit through bounded `api.github.com` requests. Every mutable ref is
resolved to a 40-character commit before discovery. Repository URLs may expose
multiple `SKILL.md` folders; the user must explicitly select one. Install IPC
then carries the discovery id, candidate id, and expected commit, never a local
filesystem path.
Default-branch tree URLs use repository metadata plus one exact-ref lookup.
Other branch/tag tree URLs use one bounded matching-ref lookup per namespace,
select the longest ref that prefixes the URL path, and cap the combined result;
request count never grows with subdirectory depth.

Before install or update, Tenon validates the complete selected subtree. It
requires strict YAML frontmatter, a canonical lowercase skill name, and a
concrete description. Missing `metadata.tenon.version` is accepted as
Unknown/Unverified; a declared npm SemVer range must include the running Tenon
version. Validation rejects traversal, symlinks, submodules, nested `.git`,
hidden support paths, executable Git modes, unsupported binary signatures,
invalid UTF-8, secret-looking content, embedded shell expansion, duplicate skill
names, and bounded file/count/aggregate limits. Source metadata such as
`.gitignore` is excluded. Text scripts may be stored, but every installed file
has its executable bits removed and install/update never runs scripts or
installs dependencies.

Managed state and immutable payloads are separate:

```text
<userData>/managed-skills/index.json, catalog-cache.json, staging/
<userData>/managed-skill-content/<skill>/<subtree-sha256>/...
```

The private index records repository, subdirectory, tracking ref, resolved
commit, whole-subtree SHA-256, compatibility, install time, enabled state, one
previous version, last checked commit, recommendation provenance, scripts, and
diagnostics. Staging is re-read and hashed before an atomic rename. The content
hash orders relative paths by UTF-8 bytes before hashing path lengths, paths,
file lengths, and exact bytes. Every control/content directory chain is
revalidated as normal directories before managed reads, writes, or deletion, so
a locally inserted symlink cannot redirect an operation outside the managed
store. The content address becomes active only after an atomic index write. A failed install,
validation, update, or registry refresh leaves or restores the prior index and
usable version. New content is removed after a failed activation only when index
restoration and registry refresh both succeed; if restoration itself fails, the
content remains so whichever index persisted cannot reference deleted bytes, and
later store initialization may prune it as an orphan. Updates may resolve a tracking ref automatically, but they only
record **Update available**. Preview downloads and validates the candidate and
shows commits, hashes, changed paths, scripts, and a bounded `SKILL.md` diff.
Only an explicit Apply flips the active hash. One clean prior version is retained
for explicit rollback.

Install creates `installed-disabled`; Enable is a separate product action.
Disable does not uninstall bytes, and Uninstall addresses managed records only.
Managed enablement is owned by that lifecycle record, so stale names in the
ordinary user/project disabled-skill setting do not override its switch.
Built-in names can never be shadowed. Install also fails on any managed, user,
or project name collision with the conflicting source/path. If a local
user/project skill later takes the same name, normal registry precedence keeps
the managed version out of resolution; managed actions never rewrite or remove
that local skill.

Installed content remains usable if GitHub, the repository, or the catalog goes
offline. Settings and invocation rehash the active subtree. A mismatch marks the
record Modified, removes it from resolution, and blocks enable, update, and
rollback; recovery is explicit uninstall and reinstall. Tenon never overwrites
locally modified managed bytes. The original compatibility ranges are retained
with each version and re-evaluated against the running app version; a version
that becomes incompatible stays installed but is excluded from runtime until a
compatible update or rollback is explicitly applied. Only an enabled, clean,
compatible version enters the skill registry, and invocation revalidates its
expected subtree hash immediately before rendering.

Managed lifecycle commands cross IPC as typed success/error envelopes. Errors
contain only a stable code and an optional bounded path/name/ref detail; internal
English exception messages never cross the process seam. Settings maps those
codes and persisted diagnostics through the active English or Simplified Chinese
message surface, including catalog fallback, validation, network, update,
modified, rollback, and uninstall failures.

## Frontmatter

Supported frontmatter fields:

- `description`: short listing text shown to the model.
- `when_to_use` or `when-to-use`: extra trigger guidance appended to the listing.
- `allowed-tools`: whole-tool catalog entries for `execution: isolated`, such as
  `file_read` or `bash`. A legacy form such as `Bash(git diff:*)` selects the
  entire `bash` tool; the command pattern has no authorization meaning.
- `arguments`: named argument bindings for `$name` replacement.
- `argument-hint`: user-facing hint for slash skill usage.
- `disable-model-invocation`: prevents automatic model invocation through the `skill` tool.
- `user-invocable`: controls slash skill usage.
- `model`: optional model override for inline skills, or sub-run model override for isolated skills.
- `effort`: optional reasoning effort override for inline skills, or sub-run effort override for isolated skills.
- `shell`: optional shell for embedded command expansion. Lin currently supports `bash`.
- `execution`: `inline` by default; `isolated` runs the rendered skill body through the same-conversation delegation runtime instead of injecting it into the parent context. An isolated skill always forks the current conversation context (the one-Neva invariant: there is no agent selection), so there is no `agent` frontmatter field.
- `paths`: path-conditional activation patterns for mutable skills.

User/project skills use directory-name identity. `name:` frontmatter is
tolerated there as a display alias, while built-ins ignore it so an app-shipped
folder cannot create an extra slash alias or bypass the built-in duplicate-name
guard. Managed import requires a valid `name:` or uses the selected directory
name as its canonical fallback, then stores the version under that identity.

`execution` is the skill-level execution mode. `inline` means the rendered body
is injected into the parent model turn; `isolated` means the rendered body is
sent to a sidechain sub-run and only the final result returns to the parent.
The actual isolation remains the same-agent delegation runtime implementation.
Legacy `context: fork` frontmatter is still accepted as an alias for
`execution: isolated`, but Skillify and built-ins no longer author it.

Mutable skills and resource-backed built-ins are loaded with:

```text
Base directory for this skill: <skill-directory>

<SKILL.md body>
```

Inline built-in skill bodies with no extracted reference files are loaded
without a directory prefix:

```text
<skill body>
```

Argument placeholders are `$ARGUMENTS`, `$ARGUMENTS[n]`, `$0`, `$name`,
`${AGENT_SKILL_DIR}`, `{baseDir}`, and `${AGENT_CONVERSATION_ID}`. For mutable
skills and resource-backed built-ins, `${AGENT_SKILL_DIR}` and `{baseDir}` both
resolve to the skill directory. For built-in skills without extracted reference
files, directory placeholders are not substituted because there is no real
directory to read from.

User/project and built-in skill bodies may include embedded shell commands using
fenced blocks that start with ```` ```! ```` or inline `!` command spans.
Commands are expanded only when the skill is invoked, after argument and
environment placeholder substitution. They execute through the same local bash
runner, folder capabilities, and control-plane boundary used by normal agent
tool calls. `allowed-tools` does not act as a command-pattern policy. Managed
skills reject both embedded-shell forms during import, so network-distributed
instructions can only invoke scripts later through ordinary model tool calls.

Additional files inside a mutable or resource-backed built-in skill directory
are not inserted automatically. Skills should refer to them with
`${AGENT_SKILL_DIR}` or `{baseDir}` and ask the agent to read or execute only the
specific files needed for the task. This keeps the default context small while
still supporting progressive disclosure for reference Markdown files, scripts,
and assets.
Built-in skills without extracted reference files have no adjacent files to
read.

Skill-named dependencies are binding at the agent-instruction level. When a
loaded or selected skill names a required library, command-line tool, runtime,
or script, Neva must first verify whether that dependency is already available
and then install or enable it directly through the ordinary task environment.
The model must not silently replace the
dependency-backed route with a hand-written approximation, a different output
format, or an unrelated tool merely because the dependency is missing. If the
dependency path is unavailable because of a folder capability, native OS
authorization, provider login, payment flow, network path, or project
constraint, Neva explains the concrete blocker. It asks only when a real
fallback choice cannot be inferred. Any unavoidable fallback states what behavior, fidelity,
compatibility, or verification it gives up.

## Runtime Flow

At the start of a normal user turn, Lin injects a hidden skill listing reminder containing only skills that have not already been listed in the conversation. This avoids repeated listing text and preserves provider prompt cache friendliness.

Only enabled, integrity-clean managed records join that listing. Immediately
before either inline or isolated invocation, runtime checks that the requested
record is still enabled, still points at the expected active subtree hash, and
still rehashes to that value. Failure invalidates the registry cache and returns
a managed-skill-unavailable result without rendering instructions.

When the model calls the `skill` tool for an inline skill:

1. `AgentSkillRuntime` resolves and validates the skill.
2. The skill body is rendered with arguments and supported embedded shell output.
3. `allowed-tools` does not change the parent Run's tool catalog.
4. `model` and `effort` are recorded as a one-turn effect.
5. The rendered skill content is recorded for post-compact restoration.
6. The tool returns `Launching skill: <name>`.
7. `pi-agent-core` receives the loaded skill as a steering user message before the next provider request.
8. `prepareNextTurn` applies the model/effort override for that next provider request only.

The renderer treats that inline `loaded` result as a compact loaded-skill line:
skill glyph, slash-prefixed skill name, and dimmed invocation args (name and args
ellipsis-truncate, with the full value available on hover). It does not show the
generic Input/Output disclosure card because the real work is the steering message
injected into the next model turn, not a user-inspectable tool output.

When the model calls the `skill` tool for an `execution: isolated` skill:

1. `AgentSkillRuntime` resolves, validates, and renders the skill body.
2. `AgentDelegationRuntime` starts a sidechain sub-run using the rendered skill body as the run prompt.
3. The sub-run is a same-agent run of Neva; isolated skills do not select a
   different agent definition.
4. The skill's `allowed-tools` entries become the isolated Run's complete tool
   catalog; omitted `allowed-tools` creates a tool-free Run.
5. The skill's `model` and `effort` fields apply to the isolated run.
6. The parent receives only the final isolated Run result or error as the `skill` tool result.
7. The rendered skill body is not injected into the parent context and is not recorded as an invoked parent skill for compact restore.

The built-in `/research` skill adds one internal restriction to that flow:
`readOnlyIsolated: true`. This is not mutable `SKILL.md` frontmatter and is not part
of `SkillDefinition`. At sub-run spawn, `AgentDelegationRuntime` narrows the sub-run
definition's catalog to the skill's declared `allowed-tools` after filtering those
tools through the exhaustive `AgentToolActionKind` read-only partition in
`src/core/agentActionCatalog.ts`, then reuses the existing `tools` /
`disallowedTools` path used by agent definitions and `createAgentTools`. Mutating
tools are absent from the child model request.

Isolated skill results stay on the normal tool-call disclosure path because they
carry a real isolated Run result or error for the parent turn.

Slash skills use the same loader and apply the same `allowed-tools`, `model`,
and `effort` metadata. `/clear` and `/compact` are built-in runtime commands and
are handled before slash skill resolution. `/skillify` is a built-in skill that
is both user- and model-invocable; it uses ordinary `file_write` / `file_edit`
after resolving any genuinely missing contract input, and the skills it writes
are available immediately without a second confirmation. Explicit natural-
language save/update/fix skill requests are
normalized to the same direct `/skillify` prompt path, so they work even when
automatic skill listing is disabled, but only while slash skills are enabled.
`/research` is also both user- and model-invocable; its `allowed-tools` select
the expected read tools and the runtime intersects them with the read-only
action catalog.

Path-conditional mutable skills remain hidden until a touched file matches
`paths`. Directory patterns such as `src` match files under that directory,
glob patterns such as `src/**/*.ts` use glob semantics, and dynamically
discovered nested `.agents/skills` directories are skipped when they are ignored
by the workspace gitignore rules. Built-ins keep their `paths` metadata for
inspection and future policy use, but they load immediately as the immutable
app-shipped floor.

File writes into any skill directory are treated as skill-content writes, not
generic local file edits after ordinary `file_write` / `file_edit` capability
preflight. **Identity has one source of truth**: the same resolver
(`resolveSkillContentTarget`) that the registry loads from also powers the
file-tool gateway, so the loader's notion of "what is a skill" and the write
validator's can never disagree — including additional configured skill
directories and nested `.agents/skills` dirs discovered at runtime.

The write boundary makes **no capability decisions — only validity and
recording**: after ordinary file-tool capability preflight, the gateway
validates `SKILL.md` frontmatter and support-file shape as immediate
feedback to the model, rejects secret-looking content (skill-specific by design:
skills are durable instructions injected into future contexts, an exfiltration
amplifier), rejects hidden/executable support files, records rollback metadata in
the tool details, records the written content hash as provenance, and hot-reloads
the skill registry.

**Ratification** is a default-allow policy layer, derived at
listing/invocation time and not at write time. Each mutable skill has one
**trust record** in
`agent-skill-provenance.json` (userData; mirrored in-memory in the registry),
keyed by resolved skill file path:

- `agentHash` — sha256 of the last `SKILL.md` content written through the agent
  file-tool path (provenance: who produced the current bytes);
- `acceptedHash` — sha256 of the content the user explicitly accepted for
  management visibility (a positive record over exact bytes);
- `previousVersion` — the one version preceding the last agent edit, for
  single-step undo.

Ratification is a **pure derivation**, never stored:

```text
ratified = true
accepted = currentHash === acceptedHash
```

All built-in, user, project, and agent-written skills are ratified by default
when they are otherwise model-invocable. A cloned repository with
`.agents/skills/.../SKILL.md` loads the skill for Settings, slash invocation, and
automatic model listing without a separate trust prompt. The only skill-level
invocation gates are explicit frontmatter/settings gates such as
`disable-model-invocation`, `user-invocable: false`, disabled skills, and
path-conditional activation. A skill's `allowed-tools` affects only an isolated
Run's visible tool catalog; inline invocation leaves the parent catalog
unchanged.

Skill invocation never opens a trust approval card. Settings → Skills may still
record or clear an `acceptedHash` for management/audit visibility.
`agent_accept_skill` records
`acceptedHash = contentHash`; `agent_revoke_skill_acceptance` clears it. Accept
carries the `expectedHash` the renderer/runtime displayed and is refused on
mismatch, so an agent write landing between render and click can never be
recorded sight-unseen. A trust action also refreshes every live conversation's
registry (the Settings panel runs without a conversation; each conversation holds
its own in-memory trust map over the same store). Trust records are keyed by
resolved file path: a user rename/move orphans the record, but the skill at its
new path remains ratified under the default-allow policy. Orphaned records are
not garbage-collected (accepted: bounded by the number of skills ever
agent-written, and a returning file at the old path correctly picks its record
back up).

**Single-step undo.** The gateway captures the pre-write content at each
`SKILL.md` agent write and stores it as the trust record's `previousVersion`
(bounded to one version — deeper history is git's job). The Skills tab exposes
**Undo last agent edit** (`agent_undo_skill_agent_edit`): the restore is
validated by the same skill-write validator, written to disk, and the
provenance facts of the previous version are restored, so accepted/audit state
re-derives with no special case. Undo may only overwrite
the agent's own bytes: it is offered and executed only while the on-disk
content still hashes to `agentHash` (the action re-reads the file), so it can
never destroy a user hand-edit made after the agent write. The slot is consumed
on undo (strictly one-shot); a create has no previous version and offers no
undo. The restored bytes are written LF-normalized (the canonical hash domain;
line endings of a CRLF/BOM-authored skill are not preserved — accepted,
pre-release).

Successful skill writes also append a run-scoped skill audit event beside the
completed tool call: `skill.created` for a new `SKILL.md`, `skill.replaced` for a
whole-file replacement, and `skill.patched` for focused edits or support-file
writes. The event records the skill id, source, tool actor, and hash transition
summary; the full previous content stays in the file-tool result details for
rollback tooling. This is execution audit detail, so it lives in the producing
run ledger rather than the conversation log.

## Reference Alignment

Lin tracks the stable local-skill path from the cc-2.1 reference. cc-2.1 is the
primary reference for invocation semantics and skillify UX; OpenClaw and Hermes
are supplemental references for safety, recovery, provenance, and curation.

- immutable built-in skills from resource-backed app folders or code-registered
  inline instructions, pinned managed GitHub skills, plus mutable directory
  skills as `<skill-name>/SKILL.md`;
- one model-facing skill invocation tool;
- user slash invocation for user-invocable skills;
- `allowed-tools` as the whole-tool catalog contract for isolated Runs;
- `model` and `effort` as one-turn overrides;
- `execution: isolated` through a sidechain sub-run, with legacy `context: fork`
  accepted only as a parser alias;
- path-conditional activation and dynamic nested skill discovery;
- post-compact restoration of invoked skill content;
- Skillify-style authoring through ordinary `file_write` / `file_edit`, with
  direct writes for explicit, fully determined requests and clarification only
  for missing contract input rather than a dedicated skill CRUD tool.
- a built-in `/research` skill implemented as a current-agent isolated Run
  whose declared read tools are filtered through the read-only catalog.

Lin intentionally uses `.agents/skills` and the lowercase `skill` tool name
instead of cc-2.1's `.claude/skills` and `Skill` tool name. This is a product
namespace choice, not a behavioral difference.

Agent-managed skill edits follow cc-2.1's smaller tool surface:
`skillify`-style workflows plus ordinary file write/edit tools after the contract
is determined. Lin adds skill-path validation, rollback metadata, provenance,
and hot reload instead of a separate model-facing skill CRUD tool family.

Skillify v2 is intentionally Tenon-native rather than a direct namespace copy:
it writes only `.agents/skills/<skill-name>/SKILL.md`, does not emit `name`
frontmatter, and separates the tools used to author a skill from the future
skill's `allowed-tools`. For an existing skill it reads the current `SKILL.md`
first and prefers a focused `file_edit` patch. Agent-written and project-source
skills are ratified by default; exact-byte acceptance remains optional
management/audit metadata rather than an invocation gate.

`/research` borrows cc-2.1 Explore's read-only boundary discipline without
borrowing its agent-shaped product grammar. cc-2.1 makes Explore safe by
restricting the agent catalog with `disallowedTools`; Lin keeps generic research
as a skill of the current agent, then applies catalog narrowing at
fork spawn. `allowed-tools` is a tool-visibility contract: Research additionally
intersects it with the runtime-owned read-only catalog.

## Compatibility Decisions

Lin follows the stable local skill invocation path from the reference
implementation where it maps cleanly onto `pi-agent-core`:

| Capability | Lin decision |
| --- | --- |
| Directory skills | Supported as `<skill-name>/SKILL.md`. Single-file legacy command skills are intentionally not supported. |
| Built-in skills | Supported as the minimal immutable app-shipped floor. Resource-backed built-in folders load before code-registered inline built-ins, and both load before managed and mutable skill directories. No other source can shadow a built-in name. |
| Automatic listing | Supported. New model-invocable skills are listed once per conversation and persisted across compact restore. Mutable skills are default-ratified; path-conditional skills still wait for a matching touched file. |
| Skill invocation | Supported through the `skill` tool and slash composer adapter. Both paths share rendering, capability handling, model, and effort behavior. |
| Embedded shell | Supported for built-in/user/project skills with `bash` only, at invocation time, after argument and placeholder substitution. Managed import rejects fenced and inline embedded-shell forms. |
| Reference files and scripts | Supported through `${AGENT_SKILL_DIR}` / `{baseDir}` plus normal `file_read` or `bash` calls. They are not bulk-loaded. For invoked inline skills with resource directories, the runtime exposes that exact skill directory as a read-only file-tool root so references can be read in both dev source-tree runs and packaged app-resource runs. |
| Skill dependencies | Binding guidance. When a loaded skill names a required library, command, runtime, or script, the global system prompt tells Neva to verify and install/enable that dependency directly instead of silently changing route. Owner-specific failures require a concrete explanation before a lower-fidelity fallback. |
| `allowed-tools` | Supported as the complete whole-tool catalog for isolated Runs. Omission creates a tool-free isolated Run; inline skills do not alter the parent catalog. |
| `model` and `effort` | Supported as one-turn `pi-agent-core` loop updates. |
| `paths` | Supported for path-conditional activation and dynamic nested skill discovery for mutable skills. Built-ins load immediately even when they declare `paths`. |
| `execution: isolated` | Supported through the runtime-owned delegation executor. Isolated skill bodies run in a sidechain worker of the current agent and return only the final result to the parent; they do not require exposing direct delegated-run tools. Legacy `context: fork` parses as `execution: isolated` for existing skills. |
| `hooks` | Not supported. Lin currently has no skill hook registration layer, so hook frontmatter is ignored. |
| Agent-managed skill writes | Supported through cc-2.1-style workflows that use existing `file_write`/`file_edit` calls. Writes into registry-recognized skill directories use ordinary folder capabilities, then the file-tool gateway validates them as feedback, emits audit events, carries rollback metadata, records provenance hashes, and hot-reloads the registry. Shell/external-editor writes are validated on discovery and invalid definitions remain unloaded. Agent-written skills are available immediately for slash invocation and, when model-invocable, automatic listing without a separate trust prompt. |
| Agent-managed agent-definition writes | Not supported. The one-Neva invariant removed agent authoring as a self-definition surface (no `/create-agent` workflow, and the self-definition write gate governs skills only). The single agent, Neva, is configured through the agent-config window (`agentUpdateAgentDefinition`), not by authoring `AGENT.md` files. |
| Legacy command directories | Not supported. Lin uses the agent skills standard path under `.agents/skills`. |
| Public GitHub skills | Supported through bounded GitHub discovery, strict subtree validation, immutable commit/hash pinning, explicit install/enable/update/rollback/uninstall, and offline local execution. Private repositories, credentials, GitLab, and other providers are not supported. |
| MCP/plugin skills | Not supported. Managed skill lifecycle does not imply an MCP or plugin lifecycle. |
| Managed/policy skills | Tenon-managed GitHub skills are supported as optional local installations. There is no separate admin policy layer and no managed source receives extra runtime authority. |
| `skillify` | Supported as the built-in user- and model-invocable Skillify v2 workflow (`when_to_use`-gated to explicit user save requests). It uses the Tenon `.agents/skills/<skill-name>/SKILL.md` shape, writes directly with existing file tools when the request determines the contract, and asks only for missing identity, storage, trigger, or behavior choices. |
| `research` | Supported as a built-in user- and model-invocable `execution: isolated` workflow with no `agent` override. It starts an isolated sub-run of the current agent, filters its declared read tools through the `AgentToolActionKind` read-only catalog, and returns a compact findings/evidence report. |
| `data-cleanup` | Supported as a Tenon-owned resource-backed built-in. It profiles local exports, runs deterministic adapters for known sources through `tenon-import`, emits Import Pack v1, validates coverage, produces an API-backed preview id, and uses `tenon-import commit` as the only bulk document write path. Tana JSON is supported as the first write route; Roam EDN is profile-only until a deterministic adapter is added. |
| `data-analysis`, `document`, `feed-processing`, `pdf`, `presentation`, `spreadsheet` | Supported as optional Linlab-recommended managed installations, not packaged built-ins. They retain their goal-oriented routes for PPTX, DOCX, XLSX, Markdown, HTML, PDF, CSV, JSON, RSS, Atom, JSON Feed, OPML, and source tables. Missing dependencies are handled later through ordinary runtime tools/capabilities; installation itself never runs scripts or installs dependencies. |
| Automatic skill improvement | Supported only as user-directed or accepted-review skill maintenance in the first self-modification release. Background conversation review that silently rewrites skills is not supported. |
| Per-skill invocation approvals | Not supported. The `skill` tool uses ordinary capabilities; `allowed-tools` selects whole tools for isolated Runs. |

## Compaction

`/compact [instructions]` creates a no-tools summary request. The summary response is expected to contain an `<analysis>` block and a `<summary>` block; only the summary is retained.

The same compact engine is also used automatically:

- before a model call when the active context crosses the auto-compact threshold
- after a provider context-length error, followed by one retry from the compacted root

Before model-context assembly, Lin runs tool-output slimming on the active path. Large tool results are persisted as payloads and replaced with stable `<persisted-output>` preview labels. Per-tool-batch budget decisions are frozen by `toolCallId` and recorded as event-log replacements, so restored conversations reuse the same model-visible content instead of re-deciding and breaking prompt-cache stability.

If the compact summary request itself exceeds the provider context limit, Lin retries by dropping the oldest API-round groups from the summary input. Reactive compact also clones the latest pending user/tool tail after the compact root before retrying, so the model continues from the same work item instead of relying on the summary to restate it exactly.

After compacting, Lin restores the most recent full text file reads into a hidden reminder with bounded per-file and total size. File-edit freshness state is cleared and rebuilt only for restored files, matching the model-visible context after compact.

After compaction, the model-context branch becomes a new root user message with:

- visible marker text: `Conversation compacted.`
- hidden compact summary reminder
- hidden invoked skills reminder
- hidden listed-skills state reminder
- hidden restored file context reminder, when recent file reads fit the restore budget

If compaction happens while a provider run is still active, the run's in-memory
message tail is re-anchored to the post-compact leaf (the compact root, or the
last preserved tail message for reactive compaction). Any later assistant or
tool-result segment from that same run must append after the compacted branch,
not after the pre-compact tail that was just summarized away.

The renderer does not show this root as a normal user bubble. `compaction.completed` is projected as a dedicated compact boundary row with the trigger (`manual`, `auto`, or `reactive`) and an expandable summary. The hidden reminders remain model-only context.

The listed-skills state reminder is intentionally tiny. It prevents a restored compacted conversation from re-injecting the full skill listing after app restart.

## Context Clear

`/clear` starts model context over from the current point without creating a
summary. It is a runtime command, not a slash skill, and it only matches the exact
command with optional surrounding whitespace; text such as `/clear notes` remains
a normal prompt.

Clearing appends a root boundary message with visible text `Context cleared.`
and selects it as the active leaf. The previous active path is recorded on a
`context.cleared` event as the cleared source range. That source remains durable:
the transcript still shows it as historical chat, search indexes can still find
it, and `past_chats` can retrieve it as prior visible conversation history.

The active model-context branch after the clear contains the `Context cleared.`
boundary and later messages only. No compact summary, invoked-skill reminder,
listed-skill reminder, or restored file-context reminder is generated. This is
the product difference from `/compact`: compact preserves older context through a
summary root, while clear intentionally preserves no summary.

## Memory Dream

`memory-dream` is a private built-in skill used only by the runtime's scheduled
and manual memory consolidation paths. It is not slash-invocable and not
model-invocable.
The runtime renders the skill with `trigger: "runtime"`, passes exact
`past_chats` source ranges plus `[[chat:...]]` marker templates whose targets are
fixed and whose visible labels must be replaced with natural sentence fragments,
and runs an unattended top-level turn in the protected Dream channel with a
Dream-only run profile. That profile disables user skills and delegation, and its
tool catalog is limited to `past_chats`, `node_search`, `node_read`,
`node_create`, `node_edit`, and `node_delete`.

The scheduled Dream gate uses the user-managed `agent.runtime.dreamSchedule`
date-schedule string (default: a fixed local daily 03:00 occurrence). A scheduled
due can retry after transient failure, but only up to three attempts for the same
due time; after that it gives up until the next scheduled occurrence. The
scheduled window covers only complete local days, ending at the day before the
due time; if prior scheduled attempts were missed, the next successful scheduled
run catches up through that last complete day. The runtime derives the Dream
cursor from clean completed `dream.finished.window` markers in the protected
Dream channel, not from mutable scheduler state. A manual Dream uses the same
restricted Dream-channel path and date-window machinery; its end date is clamped
to today, its default start falls back to today when the derived cursor has
already reached today, and when it completes a day, that completed window
suppresses the scheduled Dream for that already-covered day. Before a manual run,
a cheap read-only readiness pre-check (`agent_dream_readiness`) counts evidence
in the default manual date window against the same volume bar the scheduled path uses;
when it is below the bar, the Settings control advises that there is little new
chat in this Dream window — a run now would mostly reconcile existing memory
rather than capture new conversations — and offers a "Dream anyway" override
rather than spending a model round-trip by default. (The advisory is about thin
*new chat volume*, not "nothing to do": a sub-bar manual run is still a valid
consolidate-only reconciliation.)
When a run has durable memory worth writing, it maintains at most one direct
`#d-memory` container under each source-date journal node, whose title is a
generated daily memory headline updated in place for that date, not the fixed
word `Memory`. Remembering nothing is a valid, common outcome: a run that finds
nothing worth remembering writes nothing — no container, no nodes — and still
completes successfully, recording a clean windowed `dream.finished` marker so
that date window is not re-read. A zero-write completion only counts as this
deliberate no-op when the run ended cleanly; a run cut off mid-work (an
unresolved context overflow truncated it) is flagged `incomplete` and, having
written nothing, is treated as a failure so the span is retried instead of being
silently dropped.

The skill applies a high-signal memory filter before writing: keep explicit or
repeated user preferences, durable project/work facts, decisions, corrections to
existing assumptions, and recurring collaboration patterns. Skip greetings,
routine transcript texture, temporary status/weather, one-off operational steps,
duplicates, low-confidence guesses, and any episode that only narrates that Neva
answered a question or otherwise acted (an episode records a durable fact about
the user or the work, never an assistant-action log). It also uses `node_search` / `node_read`
to pull relevant outline context before writing: prior `#d-*` memory nodes are
the current belief graph to reconcile, and user-authored outline nodes provide
workspace context for projects, tasks, decisions, tools, and workflows. Prior
Dream output is never self-confirming evidence by itself. Manual
`consolidate_only` runs may have no new chat sources; in that case Dream
consolidates from source-date outline context, prior Dream memory, and relevant
user-authored outline context.

Dream writes ordinary tagged outline nodes with a human-dream cycle:
`Replay → Associate → Reconcile → Abstract → Expose tension → Simulate future →
Downselect`. `#d-episode` captures a replayed episode or observed pattern,
`#d-belief` captures a stable model update, `#d-question` captures unresolved
tension or uncertainty, and `#d-guidance` captures a future handling note. The
tags are optional: an episode does not need all three, and a `#d-question`
or `#d-guidance` is written only when it improves future behavior. Citations are
selective: an episode-level `[[chat:...]]` marker can cover child nodes that use
the same evidence, and child beliefs/questions/guidance add their own marker only
when a specific claim needs auditability or disambiguation. Dream may update,
merge, move, or delete any ordinary outline node when consolidation warrants it;
deleted nodes are moved to Trash through `node_delete`, not permanently removed.

There is no `/dream` slash command and no foreground `dream` tool. The Dream
channel is a protected default channel: it cannot be renamed or deleted, does
not accept ordinary chat messages, and is forced out of future Dream evidence.
Ordinary channels default into Dream evidence and expose an "include in Dream
data" setting in Channel configuration so the user can exclude them. The Dream
channel's visible transcript contains the manual or scheduled Dream anchor and
assistant/tool activity; `dream.finished` is metadata attached to that anchor,
not a replacement row inside the Dream channel. That transcript is audit history,
not the next Dream run's prior chat context: Dream starts with an empty active
path, ordinary `past_chats` lookup excludes the Dream channel, and Dream reads
source evidence only through the runtime-provided prompt, `past_chats`, and
explicit outline memory/context tools. The audit transcript is bounded: the
runtime retains the most recent 512 Dream-channel runs and prunes older run
ledgers, their launch anchors, their `dream.finished` markers, and their search
index entries without pruning durable memory nodes or completed date windows
needed for the derived Dream cursor.
Durable model-readable results are ordinary `#d-memory`, `#d-episode`,
`#d-belief`, `#d-question`, and `#d-guidance` outline nodes.

### Reference Alignment

Lin intentionally keeps the model-context parts of the reference compact path and drops compatibility layers that do not map to the current product architecture.

Replicated behavior:

- Run stable tool-result slimming before compact/model context assembly.
- Run time-based microcompact before auto compact, keeping the latest compactable tool results.
- Auto compact before a model call when the active context crosses the model threshold.
- Reactive compact after a provider context-length error, then retry from the compacted root.
- Retry compact-summary requests that are themselves too large by dropping oldest API-round groups and inserting a synthetic truncation marker when needed.
- Preserve the latest reactive user/tool tail after compact so the failed turn can continue.
- Re-anchor any still-active run to the post-compact leaf before appending later assistant/tool segments.
- Restore invoked skill content after compact with per-skill and total budgets.
- Preserve listed-skill state after compact without re-injecting the full listing.
- Restore recent full text file reads after compact, bounded to 5 files, about 5k tokens per file, and about 50k tokens total.
- Skip file restore when a preserved tail already contains a real full `file_read`, but do not skip when the preserved tail only contains a `file_unchanged` stub.
- Clear file-edit freshness on compact and rebuild it only for restored files.
- Stop repeated auto-compact attempts after consecutive failures.

Intentional omissions:

- Session-memory compact: omitted because Lin does not use this memory model.
- Pre/post/session-start compact hooks: omitted until Lin has a first-class hook system.
- Plan-mode and plan-file attachments: omitted because Lin does not have that separate plan-mode runtime.
- Task-output-file compatibility tools: omitted because Lin follows cc-2.1's preferred path of surfacing durable output references that can be read with `file_read`. Ordinary work inspection goes through `issue_read` and `agent_session_read`.
- Deferred-tool/MCP delta re-announcement: omitted for now because Lin's tool registry is stable in `pi-agent-core`; future plugin/app tools should add their own compact restore state.
- Provider-specific cache-edit microcompact: omitted because it depends on cache editing support that is not available through the generic pi provider path. Lin uses stable event-log replacements instead.
- Prompt-cache telemetry and survey plumbing: omitted because it is observability, not model-visible behavior.
- Partial compact around a selected transcript pivot: omitted until there is a UI workflow that needs it.
- Legacy command directories and legacy config paths: omitted because Lin follows the agent skills standard paths only.

## Tool Catalog Inputs

The delegated-operator capability model is defined in
`agent-tool-permissions.md`. Skills cannot expose a tool that the runtime did not
register, bypass a user block, grant a folder, or access private Tenon control
state.

- Inline skills inherit the parent Run catalog unchanged.
- Isolated skills receive exactly the whole tools named by `allowed-tools`.
- Omitted `allowed-tools` creates a tool-free isolated Run.
- Legacy command-pattern suffixes are ignored after extracting the tool name.
- Research and verifier Runs receive an additional runtime-owned read-only
  intersection before provider execution.

Legacy `permission-mode: trusted` frontmatter is ignored and creates no hidden
authorization state.
