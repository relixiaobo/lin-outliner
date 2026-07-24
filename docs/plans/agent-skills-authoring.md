# Agent Skill Authoring And Maintenance

## Goal

Finish the two remaining Skill maintenance capabilities on the canonical Agent
Core:

- allow an explicitly requested Skill authoring workflow to create validated
  executable support files without granting any execution authority; and
- provide an opt-in, dry-run curation report for model-authored Skills.

The surrounding model stays simple: a Skill is a local `SKILL.md` instruction
bundle selected by Thread configuration. It is not an Agent identity, execution
record, permission container, or persistence root.

This plan has shape **(b): two independent complete features**. Executable
support-file authoring and curation reporting ship in separate PRs. Either PR is
complete and useful without the other.

## Non-goals

- No model-facing Skill CRUD family. Creation and edits continue through
  `skillify` plus ordinary file tools.
- No Skill-owned Agent, Thread history, Goal, or tool authority.
- No background model that silently rewrites, merges, deletes, or archives
  Skills.
- No sandbox, permission profile, approval state, or capability-acquisition
  flow. Full Access, explicit blocks, the effective tool catalog, and native
  failures remain authoritative.
- No mutable built-in Skills.
- No remote marketplace, plugin, or MCP Skill lifecycle.
- No compatibility path for removed Skill metadata or storage.

## Design

### One library, configuration-selected bindings

Canonical Skill identity is the directory name. Discovery classifies storage as:

| Source | Storage | Mutation |
| --- | --- | --- |
| `built-in` | packaged/code-registered resources | immutable |
| `user` | configured user Skill roots | mutable |
| `project` | `.agents/skills/` under the active work tree | mutable subject to filesystem authority |

Additional directories and dynamically discovered nested directories are
classified by location; discovery mode is not a fourth source identity.
Symlinked paths resolving to the same `SKILL.md` are deduplicated.

A root Thread's `ConfigurationProfile` selects Skills by name. An `AgentRole`
may narrow the selection for a child Thread but cannot add a Skill outside the
parent's effective capability ceiling. There is no per-Agent private Skill
folder and no per-Thread copy of Skill content.

Execution mode is one of:

- `inline`: load instructions into the current Turn; or
- `isolated`: spawn a child Thread, intersect its tools, Skills, plugins, and MCP
  servers with the parent ceiling, and return terminal output through the parent
  `collabAgentToolCall` Item.

`allowed-tools` is a canonical tool-name selection. It may narrow the effective
catalog for isolated execution and never makes a blocked or absent tool
available. Inline execution does not rewrite the current Turn's catalog.

### Skillify and ordinary file mutation

`skillify` remains an immutable built-in workflow. It activates only for an
explicit request to create, save, update, or repair a reusable Skill. It derives:

- normalized Skill identity and `user` versus `project` storage;
- positive and negative invocation guidance;
- arguments only when future calls need them;
- `inline` versus `isolated` execution;
- the minimal future `allowed-tools` set; and
- instructions, support resources, success criteria, and human checkpoints.

For a fully determined request, the active Turn writes directly through ordinary
file tools. A material unresolved choice uses root-only `request_user_input`;
plain follow-up text remains normal `userMessage` input. Existing Skills are read
before editing and receive a focused patch when possible.

The authoring gateway is selected by resolved target path, not by model-provided
metadata. It owns path containment, symlink defense, format/size validation,
secret scanning, atomic replacement, previous-content capture, provenance hash,
and registry refresh. Built-ins and immutable configured roots fail closed.

Accepted content hashes remain optional audit metadata. Authoring does not
create a pause/resume authorization flow and does not change whether the host
account can use a file tool.

### Feature A: executable support-file authoring

The current authoring gateway rejects every executable support file. Replace
that blanket rejection with a narrow authoring contract that permits textual
scripts only when all of these are true:

1. The active root user Turn invoked `skillify` from an explicit user request to
   create or update a Skill that materially requires a script.
2. The resolved target is inside that mutable Skill directory and is not
   `SKILL.md`, hidden content, a symlink escape, or a built-in resource.
3. The file has an allowlisted text-script type and encoding, stays below the
   support-file byte cap, and contains no NUL/binary payload.
4. The `skillify` contract names the file, its purpose, inputs, outputs, and the
   ordinary canonical tool needed to run it.
5. Secret scanning and existing Skill bundle validation pass before the atomic
   write commits.

The Turn-scoped authoring scope is host-derived from the invoked `skillify`
workflow and target Skill identity. A model cannot enable it by adding
frontmatter or choosing a filename. It expires with the Turn and cannot be
inherited by a child Thread.

Allowlisted initial script forms should be deliberately small, such as `.sh`,
`.js`, and `.ts` UTF-8 source. Adding Python or other runtimes requires proving
the runtime exists in the supported environment; a file extension alone is not
that proof. Native binaries, package archives, Mach-O/ELF/PE content, dynamic
libraries, installers, and hidden executable content remain blocked.

Writing a script grants no execution right. Later execution uses the ordinary
shell/process capability visible to that Turn, with the same canonical tool
identity, explicit blocks, Full Access audit, and native OS behavior as any
other command. `allowed-tools` cannot widen that catalog. The gateway must not
introduce a second executor, sandbox, trust prompt, or special process token.

Before reporting success, authoring rereads and hashes every written support
file, validates all relative references from `SKILL.md`, refreshes the Skill
registry, and records the exact bundle hash. A partial multi-file write is
reported as failed with the files that committed; it is never described as an
atomic bundle transaction unless the implementation actually provides one.

#### Feature A verification

- Explicit Skillify creation can write one allowlisted text script and load the
  resulting Skill without restart.
- A normal Turn, child Thread, fabricated frontmatter flag, path traversal,
  symlink escape, binary content, oversized file, hidden file, or built-in target
  cannot enter the executable authoring path.
- A successfully authored script still cannot execute when the shell/process
  tool is absent or explicitly blocked.
- Parent capability ceiling tests cover isolated Skill execution after the
  script exists.
- Provenance, previous-content undo, content hash, and hot reload survive restart.

### Feature B: opt-in curation dry run

Curation is a host-owned analyzer over the Skill registry and provenance store.
The first delivery is read-only and runs only from an explicit Settings action
or foreground root user request. A later Automation may call the same analyzer,
but scheduling is owned by the Automation plan and does not change curation
semantics.

Default scope is limited to current versions with model-write provenance. It
excludes built-ins, user-authored content without model provenance, project
Skills from untrusted external repositories, pinned Skills, and any Skill whose
content changed after the provenance hash was recorded.

The analyzer reports deterministic evidence before any model interpretation:

- load/format failures;
- missing referenced resources;
- stale path conditions;
- exact content duplicates;
- likely semantic duplicates, clearly labeled as suggestions;
- unused model-authored Skills when reliable invocation evidence exists; and
- bundles whose current tool names no longer resolve in the canonical registry.

The output is a typed report with Skill identity, content hash, evidence,
suggested action, and confidence. It contains no mutation command. The UI allows
inspection and opening the owning `SKILL.md`; it does not offer a one-click
destructive apply from the report.

Applying a recommendation is a separate foreground Turn or direct user file
action. That action rereads the current hash and uses ordinary file mutation. A
stale report fails rather than acting on changed content. Prefer archive over
delete, and never merge two instruction bundles without presenting a concrete
result to the user.

The report may be persisted as bounded diagnostic metadata or regenerated, but
it is not a Goal, ThreadItem history substitute, or Node content unless the user
explicitly asks the Agent to write a Node summary.

#### Feature B verification

- Default scope includes only unchanged model-authored Skills.
- Built-in, hand-authored, changed, pinned, and out-of-scope project Skills are
  excluded with a visible reason.
- Exact duplicate, broken reference, stale tool name, and malformed Skill
  fixtures produce deterministic findings.
- Semantic suggestions never mutate content and remain clearly distinct from
  deterministic findings.
- Re-running against unchanged inputs is stable; applying from a stale hash is
  refused.
- A scheduled invocation, once Automations exist, produces the same report as a
  foreground invocation and gains no extra tools.

### Specs and ownership

Feature A updates `docs/spec/agent-skills.md` and the authoring gateway tests.
Any shared Tool/Thread contract change follows interface-first ownership before
consumer code. Feature B updates the Skill spec plus its Settings/diagnostic
surface specification. Neither feature changes `docs/TASKS.md` or
`CHANGELOG.md` from a dev branch.

Each PR runs repository-required typecheck, relevant Core and renderer tests,
focused E2E coverage where UI changes, docs check, diff check, and light/dark
visual verification for new Settings surfaces.

## Open questions

- Which minimal script extensions have a guaranteed supported interpreter on
  the packaged macOS target?
- Should multi-file Skill authoring become a real host transaction, or should
  the UI continue to report each committed file independently?
- Where should read-only curation reports live: transient Settings state or a
  bounded diagnostics store keyed by registry fingerprint?
- What reliable invocation evidence is sufficient to label a model-authored
  Skill unused without turning absence of telemetry into a false claim?
