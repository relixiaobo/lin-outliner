# Agent Skills

A Skill is a local `SKILL.md` instruction bundle selected by Thread
configuration. Skills add reusable procedural guidance; they do not create a new
execution entity or capability authority.

## Sources And Identity

Skills are instruction packages discovered from four ordered sources:
built-in, Tenon-managed, user, and project. Canonical identity is normalized
from frontmatter and path metadata. Later sources may shadow an earlier Skill
with the same identity only through the documented precedence rules; duplicate
or malformed identities within one source are unavailable with diagnostics.

Built-in Skills are registered product capabilities. The `delegate` Skill is
built in but enters the catalog only when experimental delegation and its
configured launcher are enabled for a root Thread. Disabling the experiment
removes the guidance; it does not restore any legacy Agent tool.

The effective Thread configuration supplies a Skill ceiling. `*` admits all
otherwise eligible discovered Skills, a name list admits only those identities,
and an empty list disables Skills. `disabledSkills` is an additional user
block. A Skill cannot widen the Thread's tool, Skill, plugin, MCP, filesystem,
network, or delegation authority.

## Format

A filesystem Skill is a directory containing `SKILL.md`. YAML frontmatter may
declare its canonical name, description, invocation visibility, argument hint
or named arguments, version, and retained resource paths. The remaining
Markdown body is the instruction source. Unknown or retired execution fields
fail validation.

Skills are inline only. The retired fields `execution`, `allowed-tools`,
`model`, `effort`, and `shell`, and embedded-shell expansion syntax are
not accepted. A Skill cannot create a hidden Thread, select a model, run setup
commands implicitly, or define a private tool catalog. When instructions need
work performed, the active Agent invokes ordinary model tools under the active
Thread's existing capability policy.

Invocation arguments are data substituted only at placeholders explicitly
authored in the body. They are never appended implicitly when no placeholder
exists. Supported positional and named placeholders are expanded by the Skill
runtime without promoting model-authored values to developer authority. A
load-only Skill advertises no argument contract; a parameterized Skill exposes
the compact authored hint or one derived from its declared placeholders.

Retained resource paths are resolved under the Skill root with traversal,
symlink, file-count, byte, and content-type checks. Skill discovery and
invocation retain stable labels and opaque Host references; transient absolute
paths are not frozen into canonical history.

## Discovery And Invocation

Discovery merges the enabled sources, validates each candidate, and emits a
bounded model catalog only when the canonical `skill` tool survives final
runtime assembly. The catalog and direct slash/natural-language routing share
that same gate. A configured or preloaded name cannot bypass it.

The model invokes one Skill by canonical identity through `skill`. Direct
renderer invocation records the same structured Skill input beside the
reader-authored message. Invocation resolves the current eligible definition,
substitutes only declared arguments, retains eligible resources, and records
one canonical `skillInvocation` context-evidence payload. Loading a Skill
returns `status: "loaded"`; it does not report a child outcome, Thread ID,
Agent Role, or execution mode.

A Skill body is application instruction. Invocation arguments and dynamic
resource observations remain untrusted data. The provider receives the
instruction through canonical context projection, never through a second
prompt overlay or private steering queue. Restart and replay resolve the
persisted invocation payload; a later invocation of the same identity is
authoritative from that point forward without rewriting history.

Dynamic discovery respects project ignore rules and may observe a Skill created
after an earlier miss. Catalog budgeting preserves complete invocation
contracts before allocating space to optional authored descriptions, so
pressure cannot turn a parameterized Skill into an ambiguous load-only entry.

Under the execution-context refactor, candidates found through task directories
still pass through this registry, its canonical identity/precedence, and its
catalog journal. Repository instruction scope does not invent a second Skill
identity or override mechanism. Context discovery never invokes a Skill, copies
its body into an additional snapshot reminder, or changes the Thread's root
Configuration Profile. Per-task receipts remain complete while an unchanged
catalog produces no repeated announcement. A distinct invocation remains a
canonical event with its own arguments and instruction payload.

The common
[Execution Context Publication](agent-model-runtime.md#execution-context-publication)
contract owns frozen publication boundaries and prefix verification. Test a
Skill discovered during A/B/A directory work, unchanged registry refreshes,
same-name candidate precedence, and compaction followed by invocation. Keep
the existing lifecycle/provenance owner and declarative settings contract.

## Tool Ceiling

A Skill has no execution authority of its own. Tools named in its prose remain
available only if they survive the active Thread's canonical catalog,
Configuration Profile, explicit blocks, and any delegated Session ceiling.
Invoking `skill` cannot grant a missing tool or change its action
classification.

For a delegated Session, Skill loading may remain available as session-local
guidance. The delegated policy still blocks root-only coordination,
background-process creation, Tool Task management, and every action outside its
frozen access ceiling. The `delegate` Skill itself is root-only through its
catalog eligibility and exact Bash admission path; a delegated Session cannot
nest delegation.

## Compaction Restore

Skill invocation is canonical typed context, not prose inferred from model
messages. Compaction checkpoints the Skill catalog journal and active inline
invocations, then restores only definitions that remain relevant after the
covered cursor. A later invocation replaces the earlier active definition for
future context while preserving both historical Items.

Restore revalidates retained resource references and degrades unavailable
inspection data instead of killing the Turn. It does not rerun commands, create
a Session, rediscover authority from old prose, or expand a retired execution
mode.

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

Undo binds a Host-resolved identity, the current Agent-write hash, and the
retained previous hash. Governed `file_edit`, `file_write`, and undo share a
per-canonical-physical-file write guard. After waiting, undo reloads the shared
provenance store, re-resolves mutable ownership, and compares the current bytes
before restoring. Unbinding, retargeting a symlink, or a competing write refuses
the stale operation. The restored version consumes the one-step history; there
is no undo chain or fallback by display name. This coordinates Tenon writers,
not external editors through an OS lock.

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

- `outline` routes all persisted Node, Field, View, Search, Daily Note, asset,
  import, lifecycle, and recovery work through the public CLI.

It executes inline because document work depends on the current request and
document context. Loading it adds guidance, not authority or another document
client. The packaged launcher and import adapters are explicit build resources;
the packaging hook restores executable mode and fails when one is absent.

### Information architecture

The Skill has three disclosure levels:

1. Its discovery description names the domain precisely.
2. Its self-contained `SKILL.md` teaches the logical model, routing decisions,
   common `create` shape, exact selection, receipt semantics, review, and
   recovery.
3. The executable registry supplies conditional detail through validated
   examples, exact help, and narrow schema fragments.

The entrypoint stays below 8 KiB and contains no copied parser table or schema
manual. Its only JSON example is byte-checked against the registry's collection
recipe. The Skill directory contains only `SKILL.md`; adapters and fixtures
live with production code and tests.

### Operating contract

Node is the only structural content identity. A Field is reusable and its values
belong to Nodes. Outline, Table, Cards, and Calendar are Views over the same
Nodes. One user intent settles as at most one Operation.

Routine exact-target work should complete after Skill load with one semantic CLI
call. Work requiring identity discovery uses one bounded read followed by one
write. A successful committed-state verified receipt proves the covered
postconditions and supplies recovery identity, so the Skill does not prescribe a
redundant verification call.

The normal authoring path is `create` or `edit`. Structured payloads travel
through Bash's separate stdin field to `--input -`; the Agent does not build
temporary files, pipelines, heredocs, loops, or helper programs. `create`
declares request-local Field keys once, and the CLI ensures compatible global
definitions without a pre-search or manual ID-reuse loop.

When the task fits the validated common `create` shape in the Skill, the Agent
executes it directly. For other unfamiliar structured work, it requests one
matching `outline example`. Exact help is next. `outline schema COMMAND --path
JSON_POINTER` is reserved for a specific unresolved fragment; bare schema
returns only a catalog, and full schema bodies are not speculative discovery.
Collection-wide summaries belong to the owner description; direct children are
the item identities projected by the View.

A failed validation supplies a precise path and corrective vocabulary. The Agent
repairs that property once. An incompatible Field ensure reports the existing
definition and differences and writes nothing.

Destructive or explicitly reviewed work uses `preview` and exact `apply`
with one idempotency key. Unknown settlement uses the exact `history
--idempotency-key` command in the receipt and is never retried. Recovery names
the completed Operation.

The import path remains `import inspect`, `import plan`, exact `apply`, and
`import verify`. Adapters are read-only and emit normalized public data plus
coverage. Unsupported coverage is an explicit fidelity limit. Valid local-date
journal records may lower to native Daily Note ensure bindings in the same
ChangeSet.

Final Agent answers link an ordinary persisted `node:UUID` as
`[[node://UUID]]`, removing the internal prefix.
## Settings

The built-in `configuration` Skill guides ordinary file edits for declarative
preferences and root Agent configuration. It routes credentials, connection
tests, Skill lifecycle, Memory reset, data deletion, application/update actions,
and diagnostics to their semantic owners instead of inventing general setters.
For every file edit it reads the generated schema, preserves unrelated JSONC,
and verifies the addressed desired/effective state against a status record from
the current Host session; a completed write alone is not proof of application.

Agent settings control additional directories and disabled Skill identities. The
delivered public source is `config/settings.jsonc`, with a generated
`settings.schema.json` and bounded `status.json` beside it. The Host validates
JSONC (including duplicate-key rejection), preserves source text on rejected
edits, records a private last-known-good snapshot, and applies accepted or
recovered values through the owning runtime. Changes apply to newly assembled
tool catalogs and to active per-Turn Skill runtimes through a catalog refresh.
Undo also reloads the restored bytes and appends a catalog delta before the next
provider request when the content hash changed. Settings never rewrite Thread
history.

Configurable command bindings use the sibling `config/keybindings.jsonc` source
and generated `keybindings.schema.json`. The configuration Skill edits that file
directly for a known chord, alternates, disable, or reset-by-property-removal.
Physical recording remains a human interaction in the Keyboard Shortcuts manager,
not a prerequisite for an Agent that already knows the chord. The Skill verifies
the `keybindings` member of `status.json`, including desired/effective divergence
after a failed global registration. No command, model tool, or CLI edits or
validates shortcut settings.

The Skills page has an explicit **Review Skills** action that generates a
read-only curation report from the current loaded registry. The report is bound
to a registry fingerprint containing each Skill identity, source, current
content hash, and recorded Agent-write hash; it is not a second settings store
and it never writes, enables, disables, deletes, or rewrites a Skill. Only
`user` and `project` Skills whose current bytes still match a recorded
Agent-write hash are included. Built-in and managed Skills, Skills without
reliable provenance, and Skills changed after the Agent write remain visible as
excluded rows with an explanation. Deterministic findings currently cover
missing or root-escaping Markdown resources, exact SKILL.md content duplicates, and
retired tool names. A report must be regenerated after the registry fingerprint
changes before any future action could use a suggestion; there is currently no
automatic apply path. The report does not infer unused Skills because the
runtime has no complete invocation telemetry, and load/parse failures are
reported by the existing Skill diagnostics rather than fabricated as curation
findings.

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
Skill that is installed but configured off still appears — installed-but-off is a
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
schema is version 3 and fails closed on the old shape before pruning content;
this pre-release format has no compatibility reader or automatic reset. Records
have no enabled flag. A fresh revision identifies every install, update, or
rollback, including uninstall/reinstall of identical bytes. Existing development
stores require an explicitly coordinated reset and managed Skills must then be
reacquired; never reset an unrelated or production store implicitly.

### One preference source, separate availability

`config/settings.jsonc` alone owns configured availability for every source:

```
configuredOn(skill) = !agent.skills.disabled.includes(skill.name)
```

The row switch reflects this preference, not integrity, compatibility, name
shadowing, path conditions, or a particular Turn's ceilings. Those conditions
remain separate availability diagnostics. Invocation additionally requires the
selected `skill` tool and current explicit blocks. Managed shell contributors
use the same configured and per-Turn eligibility, including `skill` selection;
retaining lifecycle inspection never grants executable environment access.

All switches use the same serialized file-backed mutation queue. Install,
update, rollback, uninstall, and product-default acquisition never write
configuration. A new identity is on by default, but a disabled identity remains
off across installation and uninstall/reinstall. Installation records own
origin, immutable versions, revision, and diagnostics only; the default
acquisition owner separately retains uninstall opt-outs. There is no activation
writer, post-install enable write, or cross-store preference transaction.

Skill source bindings and disabled identities are exposed through a Skill-owned
settings view and update route. They still persist under
`config/settings.jsonc`, but the Skill Library does not edit the aggregate Agent
runtime settings DTO; the Host applies the accepted file result to the active
Skill runtime and publishes the scoped `skills` configuration event. This keeps Skill
configuration ownership local while preserving one source of desired state.

### Lifecycle owner and Agent tools

`createManagedSkillsHost` exposes one lifecycle facade over the managed service,
provenance store, and Skill runtimes. Human IPC and root Agent tools use that
owner; neither calls the other. `skill_inspect` lists the library, inspects exact
targets and provenance, browses the catalog, discovers sources, checks and
previews updates, and reads curation reports. `skill_manage` installs, applies
updates, rolls back, uninstalls, or undoes an Agent definition edit. Preference
changes remain ordinary public configuration edits; no settings CLI exists.

Both tools have strict object-rooted schemas with nested operation variants.
They are root-only, independently selected and globally disableable. Admission
and deferred commit checks enforce the active Turn, selection, global tool
disablement, and action blocks. `agent.skill.inspect` and `agent.skill.manage`
are distinct actions. Network-bearing operations add `web.fetch`; local
rollback and undo do not. Undo also evaluates the Host-resolved file-write path,
including sensitive-path blocks. A lifecycle tool never grants `skill` invocation.

Managed mutations bind identity, revision, and active hash. Update adds a
preview and candidate hash; rollback adds the retained previous hash. Discovery
pins repository, subdirectory, candidate, and commit. The downloaded instruction
body must match the full reviewed body. No model-provided approval, private
path, or display-name fallback can select or authorize a mutation.

Install, update, rollback, and uninstall open the same Skill-owned native review
window for human and Agent callers. It shows full admissible instructions as
inert text, source, commit, scripts, and bounded update differences. The window
fills its native frame; content scrolls independently of its action footer.
Only its designated main frame may submit a boolean decision through the
narrow preload. The Host binds it to its originating window or Thread/Turn/Item,
exact target, and the remaining 30-minute discovery/preview lifetime. Caller
loss, cancellation, renderer/window/Host loss, or timeout writes nothing. Target
and authority are checked again under the mutation guard; no lock is held while
waiting for the user. Concurrent reviews remain independent and unrelated Turns
can progress. Undo's validated one-step restore needs no new review prompt.

Lists and curation reports default to 20 entries and cap at 50, with cursors
bound to the caller view and snapshot. Discovery, update summaries, and preview
paths are byte-bounded with explicit omission counts and narrower-query
guidance. Model truncation never shortens the human instruction review.
Canonical results distinguish cancellation, expiry, stale targets, unavailable
resources, conflicts, and denial. Success reports the committed version,
removal, or restored hash separately from observed availability and runtime
refresh. Post-commit cleanup or refresh failure does not reverse saved content
or imply that replay is safe.

Lifecycle commits invalidate primary and active Turn registries; undo reloads
provenance. The next eligible provider boundary appends the canonical catalog
delta without rewriting history or adding a tool to an admitted Turn. A narrow
library-change event refreshes open lists, provenance, and category counts;
refresh generations and pending-mutation fences preserve newer user changes.

### Acquisition behind `+`

Acquiring a Skill is occasional, so it does not occupy the page. The list header
carries an icon-only `+` (B6) whose menu has two entries:

1. **Add Skill** — one panel holding the recommended catalog *and* a GitHub URL
   field, because browsing and pasting are two inputs to the same act. The
   existing compatibility/integrity review still gates the install.
2. **Add Local Directory** — a native directory picker appending to
   `additionalSkillDirectories`.

The install review shows the candidate description and the complete bounded
`SKILL.md` body before installation. Discovery marks a body that exceeded the
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

A bound source has the mode selected at bind time. `container` reads only the
folders inside it; a direct `SKILL.md` is not treated as that container's own
Skill. `skill` reads the selected folder itself, so the source scope is exactly
what the user picked and no sibling folder is implicitly included. This explicit
choice avoids deciding ownership from ordered guesses at write time. A picker
selection with an invalid Skill basename is stored as `container`, never as an
invalid exact Skill.

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

Each additional source persists an explicit mode in `agent.skills.sources`:

```jsonc
{
  "agent": {
    "skills": {
      "sources": [
        { "path": "~/skills", "mode": "container" },
        { "path": "~/projects/my-skill", "mode": "skill" }
      ]
    }
  }
}
```

`container` loads valid direct-child Skill directories. `skill` loads the
selected directory itself and uses its basename as the Skill identity. The
mode is persisted and reused by discovery, reload, write attribution, and
unbind; no runtime ordering or content-based guess changes it. A `skill` source
with an invalid basename or an unreadable `SKILL.md` is unavailable, while its
configured root remains an explicit governed admission target for repair.

Global Skill availability is declared in `config/settings.jsonc` under
`agent.skills.disabled`, and additional source directories are listed under
`agent.skills.sources`. The Host applies accepted changes to new and existing
Skill runtimes after a bounded file-watch debounce. The generated
`config/status.json` reports the observed source digest and current Host session;
it is diagnostic output only and is never an editing surface.
The native picker returns the same explicit mode: a directory containing a
direct `SKILL.md` is offered as `skill` when its basename is valid; all other
directories are `container`. Selecting a Skill never widens the binding to its
parent. Unbinding removes only the persisted pointer and never deletes user
files.

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

Availability is shown inside the independent Skills manager. Settings discovery
does not load Skills or maintain an update-count badge.

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
