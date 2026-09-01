# Agent Skills

A Skill is a local `SKILL.md` instruction bundle selected by Thread
configuration. Skills add reusable procedural guidance; they do not create a new
execution entity or capability authority.

## Sources And Identity

Skill discovery uses this precedence:

1. immutable code-registered or packaged built-ins
2. project Skills under `.agents/skills/`
3. user Skills under the configured user root
4. explicitly configured additional Skill directories
5. dynamically discovered nested Skill directories

Canonical identity is the directory name. A loaded Skill records source,
resolved file identity, content hash, metadata, and resource root. Symlinked
paths that resolve to the same file are deduplicated.

Built-in identities are display-safe pseudo paths and are never presented as mutable
Skill definitions. A resource-backed built-in may separately expose its normalized
bundle directory as a live read locator. Mutable Skills resolve to their real
`SKILL.md` files.

**One failing source never takes out the registry (A12).** A registry load that
throws clears every loaded Skill, built-ins included, so the managed source — the
only one behind a user-writable JSON index — is loaded defensively: a managed
index that cannot be decoded degrades to "no managed skills", and a managed root
missing a readable `SKILL.md` drops that row alone. Otherwise one unreadable index
costs the user every Skill they have: no slash commands, no library, and a throw
on any turn that touches Skills.

Decoding that index stays fail-closed — it admits records into the store — but the
verdict is no longer permanent. `ManagedSkillStore.initialize()` moves an index it
cannot decode aside (renamed, never deleted) and starts empty, after which the
orphan-version prune reaps its content and the Skills are reinstallable. Pre-release
we do not migrate formats, so a schema break is a reinstall, not a broken app.

## Format

YAML frontmatter may define description, usage guidance, allowed tools,
arguments, model, effort, path conditions, and execution mode. The Markdown body
contains the instructions. Resource references resolve from the Skill directory.

Execution mode is `inline` or `isolated`:

- `inline` loads instructions into the current Turn.
- `isolated` creates a child Thread with a bounded tool catalog and returns its
  terminal output to the parent Item.

Inline Skills are side-effect-free instructions. `allowed-tools`, `model`, `effort`,
`shell`, and embedded shell expansion are valid only with `execution: isolated`;
file-tool authoring and runtime loading both reject an inline declaration or body
containing any execution override. Invalid content fails instead of silently changing
mode or partially applying metadata.

Invocation arguments are task input, not a second instruction source. Inline Skills
substitute values only at placeholders explicitly authored in the Skill body; arguments
are never appended implicitly when no placeholder exists because the canonical user
message already carries the task. Isolated Skill instructions never interpolate
argument values. Their placeholders refer to the separate child user message that
carries the exact invocation task, so model-authored arguments cannot acquire developer
authority merely by appearing after the Skill body.

## Discovery And Invocation

Every ordinary start or steering admission refreshes the current Skill registry and
builds one deterministic bounded snapshot. The canonical reducer compares it with the
Thread journal and records:

- one complete `skillCatalog` baseline for the first model-visible Turn in an epoch;
- no Item and no provider tokens when the catalog hash is unchanged; or
- one delta containing only added, changed, and removed entries, chained to the
  previous catalog hash.

Registry results are filtered through the Turn-stable Configuration Profile or Role
Skill ceiling before cataloging or invocation. `*` keeps every discovered Skill,
an explicit name list is an allow-list, and an empty list disables all Skills. The same
filter applies to catalog evidence, composer slash choices, direct slash admission, and
the model `skill` tool.

Catalog evidence is appended at the current user tail, never interpolated into the
stable system prompt, so a new or changed Skill preserves every previously exposed
provider byte. Refresh preserves activated path-conditional Skills and dynamically
discovered nested Skill directories. A Skill created through file tools can append a
delta before the next provider request in the same Turn; a Skill added or edited
outside Tenon appears on the next accepted input in an existing Thread.

The runtime acknowledges a pending refresh checkpoint only after the canonical catalog
Item is published. A failed publication therefore remains retryable, and a concurrent
later refresh cannot be consumed by an older snapshot.

The `skill` model tool invokes a selected Skill. User-invocable inline Skills may also
be resolved from direct slash input. An isolated slash Skill remains ordinary user
input until the model invokes it through the canonical `skill` tool. Both paths publish typed `skillInvocation`
evidence before instructions can affect the model. Direct invocation evidence is
admitted before the unchanged canonical `userMessage`; model invocation evidence is
durable after the complete Skill tool Item and before the next provider request.

An invocation snapshots canonical identity, content hash, exact rendered authored
instructions, arguments, source, execution mode, resource root, constraints, invocation
source, and time. Inline instructions project as application guidance; isolated authored
instructions remain child-only developer instructions, while the invocation task is the
child's canonical user message. Dynamic embedded-shell results are excluded from the
instruction snapshot and admitted separately as untrusted child observations. The parent
receives identity, constraints, and the tool result for audit. The model-facing `skill`
tool requires the parent to preserve the user's task and
explicit constraints in arguments without inventing an implementation plan or
overriding the Skill workflow. There is no prompt overlay, private steering queue, or text parser. Restart
replays the same payload bytes from canonical Items. A later invocation of the same
canonical name is authoritative from that point forward without deleting or rebinding
older evidence.

`resourceRoot` is deliberately a live Skill-bundle locator, not a Thread-owned payload
or a compatibility copy. Skill support files are external executable inputs and are read
through the ordinary Full Access file tools and capability policy; the runtime does not
maintain a second Skill-specific read-root authority. Once read, their exact observed
content is frozen by the canonical tool Item and complete output reference. If the live
bundle later changes or disappears, a new read observes that current state or fails
normally, while replay of prior instructions and tool results remains unchanged. Forking
copies only resources already admitted into canonical Thread history; it does not clone
an installed Skill bundle.

Path-conditional Skills become available after matching files are touched.
Dynamic discovery respects project ignore rules and can observe a Skill created
after an earlier miss.

## Tool Ceiling

Only isolated Skill metadata may select tools or execution settings, and it cannot
widen the effective parent catalog. Isolated execution intersects its declared tools
with the parent ceiling. Plugins and MCP servers obey the same parent ceiling through
child configuration. Generic `execution: isolated` remains; a Skill has no separate
read-only mode of its own, but an isolated child inherits an enclosing Agent's durable
`readOnly` ceiling and cannot reset it with `allowed-tools`.

Embedded shell snippets are valid only in isolated Skills and execute from the already
recorded canonical `skill` tool Item through the standard shell capability and its Full
Access capability evaluation. Invocation values for `$ARGUMENTS`, `$ARGUMENTS[n]`,
`$0`/`$1`, and named placeholders travel through host-controlled environment bindings;
argument bytes are never interpolated into the authored command source. A Skill never
bypasses explicit blocks.

## Compaction Restore

The reducer reconstructs catalog state and the latest active inline invocation for each
canonical name from Thread-owned payload Items. It validates any existing compaction
checkpoint against full prior catalog entries and invocation payload references and
records a typed degradation rather than inventing display metadata from a sparse or
unavailable checkpoint. The affected catalog or invocation is omitted until a later
baseline restores it; the provider request, compaction, fork, and delegation continue.

The provider projector selects the latest context epoch and replaces compacted raw
history with the summary plus validated checkpoint. It restores the exact active inline
Skill payload references as application instructions. `/clear` ends the journal and
active invocation set; the next ordinary admission records a complete baseline from the
then-current registry. No reducer state is reconstructed from reminder text or current
Skill files during replay.

Reduction recursively includes typed inherited Turns and prior compaction checkpoints
for history forks and old canonical payloads. Fresh Agents do not inherit the parent
Skill journal: general/Role startup receives a newly assembled available catalog plus
complete Role-preloaded Skill content, while `explore` and `plan` omit the catalog.
Repeated compaction carries an Agent's own active invocation references forward instead
of re-reading mutable Skill files.

Isolated child output is not restored as reusable Skill guidance. A future call
starts a new child Turn under current configuration.

An isolated child receives the loaded Skill body as host-owned developer instructions
and the invocation task as a separate user message. The developer block explicitly
defines the user message as task input rather than workflow authority. An invocation
with no task receives only a neutral execute-without-additional-input message; the host
never manufactures task content from the parent conversation. Embedded shell syntax is
replaced in that developer block by a stable observation marker. Each command result is
persisted as an `untrusted` / `observation` additional-context entry, never as developer
or system guidance. Related retained resources are linked into the child Thread before
admission, and projection resolves disposable readable observations from opaque resource
references so transient paths are not frozen into canonical history and exact bytes are
not copied.

Every isolated Skill catalog entry appends a host-derived execution constraint.
The constraint states that invocation runs once in a single isolated child Thread
under an explicit tool ceiling. When that ceiling does not include `agent`, the
catalog explicitly tells the parent that the Skill cannot perform Agent fan-out and
that parallel orchestration belongs in the parent Thread. This capability fact is
derived from the effective Skill definition;
it is not hand-maintained prose in individual Skill bodies. Catalog budgeting
reserves every isolated execution constraint before allocating space to authored
descriptions, so pressure cannot silently remove the capability contract.

The isolated Skill tool result records the child Turn outcome separately from the
Skill execution mode. A completed outcome wraps the child's completed final
text as a result to synthesize directly and tells the parent not to repeat covered
work unless the result reports a gap or independent verification is explicitly
required. The Skill tool is the only model-facing result channel for that isolated
child; it never emits an Agent task notification or consumes Agent depth/concurrency.
Failed or interrupted outcomes are labeled as partial evidence rather than being
described as completed.

## Authoring And Provenance

Mutable Skill edits are ordinary file mutations. Provenance records which bytes
the agent wrote and the one version preceding that write, so a model edit can be
undone; it records nothing about approval. There is no accept-before-use gate: a
per-Skill ratification step is an approval policy, which
[agent-tool-permissions.md](./agent-tool-permissions.md) states Tenon does not
have. A Skill is usable as soon as it exists and is enabled.

Model-authored Skill content is rejected only when a high-confidence credential
signature or private-key header is present. Ambiguous secret-like prose passes
unchanged so the authoring guard does not become a general content block.

Undo restores only the version immediately preceding the latest model write and
is refused after a subsequent user edit. Built-ins and configured immutable
resource roots cannot be authoring targets.

`skillify` is the built-in authoring workflow. It derives a concrete Skill
contract from an explicit request, writes the mutable bundle, and relies on the
same provenance and capability checks as any file edit.

## Third-Party Tool Integration

Tenon does not distribute executables, and a Skill install runs nothing: the
managed installer fetches, validates, and writes bytes, then re-checks that no
installed file carries an executable bit. That inertness is what makes
installing from an arbitrary public repository defensible, so it is a boundary,
not an omission.

A third-party command-line tool therefore integrates entirely through a Skill
published in **the tool's own repository**, carrying three things: the
prerequisite it declares, a preflight that verifies the installed version and
states how to obtain or upgrade it, and the command surface the model needs.
Provisioning happens at first use — the Agent runs the stated command through
`bash`, classified and decided by the ordinary capability path, with the user
present and in context — never at install time, where the user has no reason to
understand what is being installed. Version pairing between Skill and executable
belongs to the tool, which is the only party that knows its own requirements;
`metadata.tenon` constrains the Tenon version only.

The Skill catalog entry is a pointer (`repository` + `subdirectory` +
`trackingRef`), never a copy, so Skill content stays versioned alongside the
code it describes and updates follow that repository. Catalog presence is
recommendation only; any compatible public repository or tree URL installs
without it.

Two consequences follow. Tenon needs no per-tool knowledge, no bundled binary,
and no release to adopt or update a tool — a first-party tool is only a Skill
whose repository we happen to own. And `AgentCoreExtension` stays a permanently
internal seam: third-party capability arrives across the process boundary,
where the existing classification and capability model already governs it,
never as code loaded into the host.

### Default-Managed Browser Pilot

Browser Pilot is the only product-default managed Skill. It is not a built-in,
and neither its Skill bytes nor its executable are packaged in Tenon. Main starts
one best-effort acquisition attempt per launch in the background. Skill-library
reads and Turn runtime admission wait only for local store initialization, never
for this GitHub work; they see either the prior/absent record or the atomically
published complete record. Publication refreshes the live registries for later
Turns. The ordinary managed validator downloads an immutable reviewed commit,
verifies the complete subtree hash, and executes none of the Skill content.

The current first-install seed is Browser Pilot Skill v0.6.1 at commit
`853e95d26acec49bcb60d8dac3bb8e5060491727`, with subtree hash
`bea2163ac5d51d8b0ec2b0c7d119dd23904079b0086bee087752eeef6aa86b6d`.
Those values authenticate only the initial acquisition; they are not a terminal
Browser Pilot or CLI version. The published record tracks `skill-stable`, never
the development `main` branch. Later releases use the ordinary managed update
check, preview, explicit Apply, and rollback flow. After Apply, the active
Skill's `compatibility.json` is authoritative for its accepted CLI range and the
exact tested CLI version installed when provisioning is needed, so a future
stable release requires no permanent Tenon-side CLI pin.

Bootstrap preserves any existing same-name or same-ID record without migration or
metadata rewriting. A private default-policy record makes uninstall durable:
opt-out is written before an official-origin Browser Pilot record is removed,
whether that record came from default acquisition, the catalog, or a direct
repository URL. A failed opt-out write stops uninstall. If the policy cannot be
decoded, Tenon quarantines its bytes and conservatively treats every product
default as opted out; it never converts corruption into silent re-enablement.
Disable keeps the record and does not opt out. Acquisition, validation, conflict,
storage, or notification failure publishes no partial record and may retry once
on the next launch.

The first relevant Agent task runs the active Skill's mandatory preflight
through ordinary `bash`. It reuses a compatible `bp` command or lazily installs
the exact tested release declared by that Skill. Tenon does not own a Browser
Pilot release downloader, follow a mutable `latest` target, migrate user-owned
legacy installations, or update the CLI independently of the active Skill.

## Built-In Floor

The packaged platform floor contains one built-in Outliner Skill:

- `outline` teaches all persisted Outliner reads, edits, history, and recovery
  through the public `outline` CLI, including complete-resource routing and
  bounded reviewed literal text transforms. Its import workflow teaches source
  inspection, optional cleanup, deterministic normalization, coverage
  accounting, one reviewed Diff/apply, and independent verification. Tana
  guidance maps only deterministic source structures and treats unsupported
  coverage as an explicit fidelity limit, not proof of a lossless migration.

It uses inline execution because document work depends on the current user's exact
request, visible document context, research, and follow-up corrections. Loading the
workflow into the parent Turn avoids a lossy model-authored task handoff and does not
widen the parent's effective tool catalog. Packaged resource staging is explicit;
arbitrary optional Skills are not copied into the application bundle. The packaged
`outline` launcher and internal read-only source-adapter worker are required resources:
the packaging hook restores executable mode where needed and fails the build when a
resource is absent.

The Skill owns no document logic. `outline` discovers current capabilities,
root/family/exact command help, completion metadata, and command-specific schemas
from the executable registry. It routes one complete resource to one porcelain
invocation, complex state for that resource to the same command's `--input`, and
dependent, cross-date, or bounded bulk work to one ChangeSet with bindings. A
known non-destructive ChangeSet uses direct `commit`; destructive, ambiguous,
conversion, high-impact, and review-requested work uses one immutable Diff
artifact and exact apply. It
never uses a shell mutation loop or intermediate created-ID lookup. For ordinary
document work it also avoids ad hoc Python, Node, or shell programs for schema
discovery, CLI-output transformation, or ChangeSet assembly; public
command-specific schemas and direct `--input -` payloads are
the execution path. Bundled source adapters remain reserved for the documented
external import workflow.

The Skill distinguishes explicit create/add from convergent set/configure/ensure,
omitted patch properties from explicit replacement, and common STRING_MATCH
shorthand from canonical structured queries. It teaches stable aliases including
`@library` and `@saved-searches`, bounded selector cardinality, complete-resource
creation, one-Operation settlement, exact Diff review, and guarded revert. It
does not copy schemas or parser tables into Skill text. The executable query
operator inventory and operand formats are generated from the public query
registry into `references/commands.md` and remain available exactly through
`outline schema QueryExpression`.

Three frequent modeling rules remain in the entrypoint because they change
ordinary task decisions. A document table is one owner with table view state,
direct child row Nodes, field-backed cells, and explicit display/group/sort
configuration; it is not Markdown or aligned text. Date field values use
`YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `start/end`, and local Daily Note dates are
not timezone-converted. Final Agent answers reference an ordinary persisted
`node:UUID` as `[[node://UUID]]`, removing the internal `node:` prefix, so the
client resolves current titles.

New view-backed collections use the mode-neutral `add --input -` viewed-tree
form and `view inspect` verification. Bash executes only `outline`; structured
payloads travel in its separate stdin field without pipelines, heredocs, helper
programs, or temporary input files. The developer-only table fixture is tested
but not linked from Agent instructions, so internal binding topology does not
enter model context.

Its Agent-facing information architecture has four layers. `SKILL.md` teaches
the inspect/choose/review/execute/verify/recover loop. A generated
`references/commands.md` gives one compact complete command-family and command
inventory. `references/changesets.md` and `references/import.md` are loaded only
for their advanced paths. Exact options, defaults, examples, schemas, and parser
admission remain registry-owned through command help and `schema COMMAND`; a
drift test byte-compares the generated command map with the registry renderer.

The Skill routes import requests to its import workflow. Bundled or
Agent-authored source adapters only read source data and emit normalized data
plus coverage; they have no Runtime write client. Public `import inspect`,
`import plan`, and `import verify` own the bounded profile, generic
ChangeSet/Diff planning, evidence binding, and post-Operation verification. An
Agent-authored task-local adapter must emit public `NormalizedImport`.
Valid Tana `journalPart` records with canonical local dates lower to native
Daily Note `ensure` bindings in the same ChangeSet, while non-date sections may
remain under a staging root. Import is append-only and never implies
deduplication or synchronization.

The Skill stops before mutation when coverage, selectors, evidence binding, or
Diff review is unresolved. After apply it reports the ordinary Operation ID,
affected set, dates, warnings, and verification result. A mismatch is never
retried or manually deleted; authorized recovery names that exact Operation in
`outline revert`.

## Settings

Agent settings control additional directories and disabled Skill identities.
Changes apply to newly assembled tool catalogs and to active per-Turn Skill
runtimes through a catalog refresh. Undo also reloads the restored bytes and
appends a catalog delta before the next provider request when the content hash
changed. Settings never rewrite Thread history.

### The Skill library

The Skills category is **one list over every source** — `built-in`, `user`,
`project`, a bound local directory, and `managed` — sorted by the name the user
reads. Provenance is an attribute of a row (a source chip), never a section: a
user thinks "my Skills", so the page is not split by where a Skill came from.
Each row carries its name, the description, a source chip, its status chips, an
enable toggle, and its source-specific actions in the row disclosure. The name
takes the `/name` slash form only where typing it works — a Skill declaring
`user-invocable: false` is model-only, and showing the slash form advertises a
command the composer filters out:

| Source | Row actions |
|---|---|
| `user`, `project`, local | show in Finder, undo agent edit, unbind directory |
| local directory | unbind directory |
| `managed` | check update, preview update, apply, rollback, uninstall |
| `built-in` | enable toggle only, plus Finder when resource-backed |

A row can open its Skill's folder when that folder is a real, mutable location.
Code-registered built-ins carry a display-safe pseudo path (`built-in/<name>`)
rather than a location, and **managed Skills are excluded deliberately**: their
content root is pinned and immutable — `resolveSkillContentTarget` refuses it —
and a hand edit there flips the record to `modified`, after which
`activeRuntimeRoots` drops it and the Skill leaves the model's catalog until it
is reinstalled. `agent_reveal_skill_directory` enforces the same fence, so it
does not depend on the UI withholding the action.

A Skill's description is written for the model to route on and routinely runs to
a paragraph. The library is a scan-and-toggle surface, so a row clamps it to two
lines with the full text on hover; clamping rather than shrinking keeps rows a
uniform height, so the list does not ripple as descriptions vary.

Managed rows are read from the managed index rather than the loaded catalog, so a
Skill that is installed but not activated still appears — installed-but-off is a
state the user owns and must be able to see and reverse.

The count shown one level up follows that same library, not only the currently
loaded runtime catalog: every non-managed runtime Skill plus every managed-index
record counts. A disabled, incompatible, or integrity-blocked managed Skill still
exists in the user's library and must not disappear from the total. Library
refreshes report the new count back to the category row.

Managed frontmatter treats `user-invocable` as a strict boolean and defaults it
to `true`; strings and numbers are invalid rather than truthy aliases. The value
is stored with both the active and previous immutable versions, projected on
every managed row, and therefore follows update and rollback. The managed index
schema is version 2 and fails closed on the old shape; this pre-release format has
no compatibility reader.

### One enable predicate, two writers

"On" has one meaning — *available to the model right now*:

```
enabled(skill) = activation(skill) && !disabledSkills.includes(skill.name)
```

`activation` is the managed index's per-record flag for `managed` Skills and
constant-true for every other source. The predicate lives in main
(`isSkillEnabled`, `agentSkills.ts`) so the model-facing catalog and the UI cannot
disagree; the library row applies the same predicate rather than reporting the
activation flag alone.

The two **stores** stay separate on purpose. `disabledSkills` is a user setting
keyed by name; the activation flag is per-installed-record and participates in
install / rollback / uninstall, which is what makes "installed but switched off" a
state the record can hold at all. It is not the default: installing a Skill
enables it, because a Skill that installs into a do-nothing state reads as broken,
and for user-initiated installs the review dialog — which shows the source, the
commit, the scripts, the description and the SKILL.md body — is where consent is
given. Product-default acquisition is the single declared exception and follows
the reviewed seed plus opt-out lifecycle above. Consent covers the instruction
because enabling is what puts a Skill's text in front of the model; the inertness
boundary below is about execution and does not reach it. Merging the two stores
would put managed lifecycle state into settings, or settings into an index that
does not own the Skills they describe. The toggle routes by source; what it
*means* never branches on source.

### Acquisition behind `+`

Acquiring a Skill is occasional, so it does not occupy the page. The list header
carries an icon-only `+` (B6) whose menu has two entries:

1. **Add Skill** — one panel holding the recommended catalog *and* a GitHub URL
   field, because browsing and pasting are two inputs to the same act. The
   existing compatibility/integrity review still gates the install.
2. **Add Local Directory** — a native directory picker appending to
   `additionalSkillDirectories`.

The install review shows the candidate description and the complete bounded
`SKILL.md` body before enabling it. Discovery marks a body that exceeded the
review bound; that candidate's Install action is disabled, and main repeats the
check before any candidate download so a stale or bypassed renderer cannot admit
instructions the user could not review in full.

Because refusing what cannot be shown decides which Skills are installable at
all, the review bound is **not** the update diff's bound and is sized well past
any hand-written `SKILL.md` — a diff is a reading aid that may be skimmed, a
review body is consent. It stays bounded only because validation admits a 1 MiB
file and the dialog has to render whatever discovery returns.

The panel is a dialog-class surface: opaque `--bg-elevated` at
`--overlay-shadow-level-2`, matching `.confirm-dialog`. Translucent material is
level-1 chrome (rails, menus); the `+` menu is that and reuses the registered
popover glass, so the library adds no new material surface.

### Local directories are pointed at, never copied

A bound directory stays the user's: edits are live, there is no snapshot to
drift, and **unbinding only drops Tenon's pointer — it never deletes files.** The
row label, the notice, and the handler all say *unbind* for that reason. A bound
directory that currently yields no Skills is still listed, so pointing at the
wrong folder stays reversible. Local Skills are ordinary `user`/`project` Skills
to the runtime; a row is identified as local by whether its `rootDir` sits under
a bound directory, and the picked path is resolved in main so that comparison is
against a canonical path.

A bound directory is a **container** of Skills, exactly like the convention
directories: Tenon reads the folders inside it, and a `SKILL.md` sitting
directly in it does not make it a Skill. Picking the folder that *is* a Skill is
just as natural, so the picker detects that and **asks** whether to add its
parent instead — rather than the runtime inferring, per write, whether a path
belongs to the bound root or to something nested under it.

It asks rather than doing it, because the parent is a wider scope than the user
chose: every sibling folder under it becomes a candidate Skill directory. Saying
so afterwards is notification, not consent. If the chosen folder's name cannot
be a Skill identity, the picker refuses and says why instead of adding something
that would list nothing.

Container shape does not make an explicitly bound directory a dedicated Skill
namespace. The loader publishes the physical child roots it successfully
admitted, and only those roots own their `SKILL.md` and support content. A path
such as `<bound>/taxes/2025.md` is therefore ordinary content when `taxes` did
not load as a Skill, and `<bound>/Research Notes/summary.md` is not rejected just
because that ordinary folder cannot be a Skill identity. Ownership includes
path-conditional Skills and valid physical roots hidden by canonical-name
precedence; invocation visibility never decides write governance. If convention
and bound candidates overlap, the most specific valid Skill root owns the path;
source enumeration order never settles ownership.

An exact `<bound>/<name>/SKILL.md` write is still a governed **admission
attempt**. This lets the agent create or repair a definition through the
identity and content validators without claiming other files under an unloaded
child directory. Admission validates the prospective bundle's existing support
files before writing the definition, including the executable, secret-looking,
symlink, per-file-size, and bounded-file-count authoring rules. An agent may
therefore write ordinary files first, but unsafe files prevent that directory
from becoming an agent-authored Skill.

Convention directories are different: `~/.agents/skills`, the workspace
`.agents/skills`, and dynamically discovered nested `.agents/skills` directories
exist specifically for Skills. They retain path-shaped ownership so a brand-new
definition and its prospective support path are governed from the first write.

The registry publishes bound-root ownership only after a complete load. A root
that was admitted remains owned while its directory is still bound and present,
even when `SKILL.md` is temporarily unparseable; a newly parsed root shadowed by
an immutable built-in is not published. Resolution waits for the current
registry generation before deciding a path, so a runtime settings bind has no
post-update ungoverned window. Definition and managed-content writes invalidate
the registry without awaiting a full scan inside the initiating mutation; the
next path resolution, catalog projection, or invocation performs the awaited
reload.

Physically identical search directories are scanned once, with convention
policy winning over a bound alias, but all logical aliases remain available for
accurate write attribution. Each requested path is canonicalized asynchronously
once, while admitted roots reuse physical identities computed at load time.
Owner selection prefers the logical alias traversed by the request and then the
deepest logical root. Canonical root matching follows a symlinked Skill to its
physical root but does not make a child symlink that escapes the root into Skill
content. Built-in and managed immutable fences remain authoritative when roots
overlap.

The runtime still does not infer that a bound directory is itself a Skill.
Resolving that meant deciding between container and self ownership at write time
from ordered guesses; "a bound directory that is itself a Skill" remains a
separate tracked seam.

**A Skill's directory name must be a valid Skill identity**
(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), and that is enforced at **admission**, not
at write resolution (A12). The loader refuses to admit such a directory, so no
loaded Skill can have an identity the authoring validator would reject. Enforcing
it at resolution instead produced the opposite: a Skill that loaded, listed and
ran while its own `SKILL.md` resolved to no target, making every write to it an
ordinary ungoverned one. The rule applies to the convention directories too.

Paths reach the renderer expanded. The stored setting may hold `~/skills` or
`./skills`, and the library decides which rows belong to a bound directory by
comparing against each Skill's `rootDir`, which is always expanded. The bound
list is capped, and reaching the cap is reported rather than silently dropping
the new entry.

Revealing a bound directory checks that it still exists before reporting
success, because the case a user clicks Reveal to investigate — a directory that
was renamed, deleted, or unmounted — is exactly the one that would otherwise
report success and open nothing.

### Update visibility

Managed update checks resolve each record's tracking ref and set `updateCommit`
when it differs. Only `managed` Skills have an upstream to compare against, so
only they participate; a user, project, local, or built-in Skill is the user's
own file.

Two triggers are ambient, and both are throttled per record on that record's
`lastCheckedAt` (6 hours): once per launch, deferred until after first paint,
and once when the Skills pane opens. The stamp is written whether the attempt
succeeded or failed — a failed attempt is still an attempt, and leaving it unset
retries a failing endpoint on every launch and every mount.

Two checks are explicit and never throttled: a header control that checks every
managed Skill, and a per-row action that checks one. The header control is
absent, not disabled, when no managed Skill is installed.

There is no periodic polling, no background download, and no auto-apply.

Availability surfaces as a **count badge on the Skills row in the settings
navigation** — a neutral count, not a status colour.

A failed check records an `update_failed` diagnostic on that record and does
nothing else (A12): it never blocks launch, raises an alert, or changes any
Skill's enabled state or pinned version. A throttled check stamps
`lastCheckedAt` on failure as well as on success, so a record that keeps failing
is retried on the same schedule as one that succeeds instead of on every launch
and every pane mount.

A library row **always keeps the Skill's own description**, and carries any
diagnostic on a separate line beneath it. Replacing the description hides what
the Skill is; omitting the diagnostic hides why it needs attention, which a
status chip alone never says — `incompatible_tenon` matters most, since
`activeRuntimeRoots` drops those records and the model genuinely cannot invoke
the Skill. The line takes the status colour only for a fault in the Skill
itself; a failed update check stays quiet, because it says nothing is wrong with
the Skill and an offline launch produces one for every managed Skill at once.

### The recommended catalog is a production artifact

`catalog/managed-skills-v1.json` is fetched live from `main` by every installed
Tenon, so it reaches users without a release. It is validated by
`scripts/validate-managed-skill-catalog.ts` (covered in `tests/core`), which runs
the *runtime* parser — `parseCatalogDocument` — rather than a second
implementation, so guard and loader cannot drift. On top of the runtime parse it
requires `compatibilityRange` on every entry, requires each `name` to satisfy the
install path's `SKILL_NAME_PATTERN`, and caps total bytes at
`MANAGED_SKILL_LIMITS.catalogBytes`; the loader stays permissive about all three
because it parses bytes it did not author.
