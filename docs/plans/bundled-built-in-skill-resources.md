# Bundled Built-In Skill Resources

## Goal

Let app-shipped `built-in` skills use the same progressive-disclosure shape as
local skills:

```text
skills/
  presentation/
    SKILL.md
    references/
    scripts/
    assets/
```

Today, built-ins are code-registered strings in `agentSkills.ts`. They are
immutable and ratified, but they have no real base directory, so
`${AGENT_SKILL_DIR}` does not resolve and a built-in cannot point the agent at
adjacent `references/`, `scripts/`, or `assets/`. That forces complex product
skills such as presentation, document, and data analysis into a monolithic prompt
body, which is the opposite of the skill system's progressive-disclosure design.

This plan's implementation shape is **ONE complete capability in one PR**:
resource-backed built-in skills. The PR is complete when an app-bundled skill
folder can be loaded, listed, invoked, compact-restored, and used through
`${AGENT_SKILL_DIR}` without weakening the immutable built-in floor. The
presentation skill is the first intended consumer, but the bundled-resource
capability stands on its own and should land before the presentation content PR.

## Non-goals

- Do not build the final `/presentation`, `/document`, or `/data-analysis` skill
  content in this PR.
- Do not introduce remote/plugin/MCP skill distribution.
- Do not make built-in skills editable by users or agents.
- Do not change skill ratification semantics: `built-in` remains always
  ratified; mutable `user` and `project` trust rules remain unchanged.
- Do not redefine the permissions model from
  `agent-permission-folder-handoff` / `agent-permission-redesign`. This plan
  assumes that folder handoff, restricted sandbox behavior, and typed conversion
  tools land separately.
- Do not solve executable support-file authoring for mutable skills. Bundled
  executable files are app-shipped product code and follow the app release/review
  path; mutable executable support files still require the later sandbox/ratify
  path.

## Design

### Built-in skill sources

Keep two built-in registration forms:

1. **Inline built-ins** — the current `BuiltInSkillInput` code strings. These
   remain for small workflows such as `/skillify` while migration is optional.
2. **Bundled-folder built-ins** — app-shipped directories containing `SKILL.md`
   and optional support files. These are read-only at runtime and source-tagged
   as `built-in`.

The loader reads bundled folders from a source-controlled app path such as:

```text
src/main/builtInSkills/
  <skill-name>/
    SKILL.md
    references/
    scripts/
    assets/
```

The exact packaging path may be adjusted for Electron build constraints, but the
runtime contract is stable: each loaded built-in has a real `rootDir` and
`skillFile`, while remaining immutable from the authoring/write gateway's point
of view.

### Loader behavior

`SkillRegistry.ensureLoaded()` should load built-ins in this order:

1. bundled-folder built-ins;
2. inline built-ins;
3. mutable user/project skills.

The built-in floor still wins. If two built-ins share a name, that is a product
bug and should fail loudly in tests or development; mutable skills with the same
name continue to be ignored because built-ins cannot be shadowed.

Bundled `SKILL.md` files use the same parser as mutable skills. Their
frontmatter maps to the existing `SkillDefinition` fields: `description`,
`when_to_use`, `argument-hint`, `arguments`, `allowed-tools`,
`disable-model-invocation`, `user-invocable`, `model`, `effort`, `shell`,
`execution`, `agent`, and `paths`.

### Prompt rendering and paths

For a bundled-folder built-in, `skillDirectoryForPrompt()` returns the normalized
bundled root directory instead of `null`. Rendering therefore behaves like a
mutable skill:

```text
Base directory for this skill: <bundled-root>

<SKILL.md body>
```

`${AGENT_SKILL_DIR}` resolves to that bundled root. The skill body can then tell
the agent to read `references/pptx-operations.md`, execute a bundled verifier, or
copy a Tenon-owned template asset only when the task needs it.

For inline built-ins, the current behavior stays unchanged: no base directory,
no `${AGENT_SKILL_DIR}` substitution, and compact bookkeeping uses
`built-in:<name>`.

For bundled built-ins, compact bookkeeping may use either the resolved bundled
`SKILL.md` path or a stable `built-in:<name>` identity plus bundled path metadata.
The important invariant is that post-compact restore does not surface a fake
editable path and does not lose the rendered body that was actually invoked.

### Authoring and immutability

The existing `resolveSkillContentTarget()` must not yield targets under the
bundled built-in root. Built-ins are app files, not governed user/project skill
content. Agent file tools may still read bundled files when a built-in instructs
them to do so, but they must not treat those files as writable skill targets.

The Settings skills list should continue to show built-ins as built-in and
ratified. Built-ins should not expose Accept, Revoke, or Undo actions.

### Support files

Bundled support files follow the skill folder conventions:

- `references/` contains Markdown guidance loaded only when needed.
- `scripts/` contains deterministic app-shipped helper code.
- `assets/` contains Tenon-owned templates, schemas, visual assets, or other
  files intended to be copied or used in outputs.

The mutable-skill write validator's hidden/executable denial remains unchanged
for `user` and `project` skills. Bundled scripts are different: they are reviewed
with product code and shipped by the app, so the mutable authoring restriction
does not block them. Runtime execution still goes through normal tool
permissions and the permission redesign's sandbox/effect evaluator.

### Packaging

The Electron build must include the bundled skill directories. The runtime
should resolve their path in both dev and packaged app modes, without depending
on the current working directory. Tests should cover the path resolver with a
temporary fixture; the packaged path should be covered by a small unit or
integration test if the build config exposes a deterministic resource path.

### First consumers

This plan enables the next skill PRs:

- `/presentation` — `SKILL.md` plus references for workflow, PPTX operations,
  visual deck system, HTML deck, asset handling, and verification. Later bundled
  scripts can validate placeholders or inspect an HTML deck.
- `/document` — professional document workflow with references for Document IR,
  templates, DOCX/OOXML, review/redline/comments, export, and render QA.
- `/data-analysis` — data workflow guidance backed by product-level tools for
  ingestion, profiling, SQL/DataFrame execution, validation, visualization, and
  artifact export.

These skills should not copy third-party skill source, templates, scripts, or
assets. The Anthropic and Guizang research only informs the architecture:
file-format operations, visual layout discipline, progressive disclosure, and
render/verify quality gates.

### Collision result

Plan-time collision self-check:

- Open PR #266 (`codex-3/agent-permission-folder-handoff`) touches
  `docs/spec/agent-skills.md`, `docs/spec/agent-tool-design.md`,
  `docs/spec/agent-tool-permissions.md`, `src/main/agentLocalTools.ts`,
  `src/main/agentPermissions.ts`, and related tests. This plan overlaps in spec
  language only. The implementation should rebase after #266 or keep the spec
  diff narrowly additive.
- Open PR #265 (`codex-4/default-general-channel-plan`) only adds
  `docs/plans/default-general-channel.md`; no implementation overlap.
- Open PR #251 (`cc-2/conversational-agent-authoring`) only adds a plan file; no
  implementation overlap.
- The likely implementation files for this plan are
  `src/main/agentSkills.ts`, a new bundled-skill source directory, Electron
  packaging config if needed, `tests/core/agentSkills.test.ts`,
  `docs/spec/agent-skills.md`, and possibly focused build-resource tests.

## Tests

- Unit test: a bundled built-in folder with `SKILL.md` loads as
  `source: 'built-in'`, `ratified: true`, model-invocable, and user-invocable by
  default.
- Unit test: invoking a bundled built-in includes the real base directory and
  substitutes `${AGENT_SKILL_DIR}`.
- Unit test: inline built-ins still render without a base directory and keep
  `built-in:<name>` compact identity.
- Unit test: mutable skills cannot shadow bundled built-ins.
- Unit test: `listAllSkills()` exposes bundled built-ins as built-in and offers
  no acceptance/undo affordance.
- Unit test: `resolveSkillContentTarget()` returns `null` for bundled built-in
  files, proving they are not writable skill targets.
- Unit test: post-compact restore preserves invoked bundled built-in guidance
  without presenting the bundled files as editable user/project skill paths.
- Packaging/build test or focused resolver test: bundled skill folders are
  reachable in both dev and packaged path resolution modes.
- Run `bun run typecheck` and `bun run test:core -- agentSkills` for the
  implementation PR. Run `bun run docs:check` after the board entry links this
  plan.

## Open questions

- **Bundled path location.** Prefer `src/main/builtInSkills/` for clear
  ownership, but confirm Electron packaging constraints before implementation.
- **Compact identity for bundled folders.** Use stable `built-in:<name>` in
  compact reminders, or include the physical bundled `SKILL.md` path? Leaning:
  preserve `built-in:<name>` as the identity and include the base directory only
  in rendered content.
- **Initial migration.** Should the first implementation PR migrate `/skillify`
  and `/research` to bundled folders, or keep them inline until the first
  resource-heavy consumer lands? Leaning: keep current inline built-ins unchanged
  and add a fixture-backed bundled built-in in tests only; `/presentation` becomes
  the first real bundled consumer in the next PR.
- **Bundled script execution.** Bundled scripts are app-shipped code, but their
  invocation still enters the normal tool/permission path. After #266 lands,
  confirm whether the script path should receive an app-owned command grant or
  always require the same confirmation as user-provided scripts.
