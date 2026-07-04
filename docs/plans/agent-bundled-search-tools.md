# Agent Bundled Search Tools

## Goal

Make Tenon's local search tools reliable without requiring the user's machine to
already have `rg` on `PATH`.

The target is the same product shape as cc-2.1's ripgrep layer: search is an
application capability, not an ambient shell dependency. Agent `file_grep`,
`file_glob`'s ripgrep fast path, the main-process local filename search, and
agent Bash commands that invoke `rg` should all keep working in dev and packaged
builds when the system has no ripgrep installed.

## Non-goals

- Do not replace ripgrep with Tenon's document index or a custom search engine.
- Do not change local file permission boundaries, realpath jailing, or sensitive
  path rules.
- Do not bundle Poppler, MarkItDown, LibreOffice, `sips`, or other conversion
  tools in this PR. They remain optional conversion dependencies with explicit
  recovery guidance.
- Do not add a user-facing installer flow or a generic dependency manager.
- Do not change tool-event rendering or hide real command failures. This plan
  removes the avoidable `spawn rg ENOENT` class; invalid command arguments should
  still report as tool failures.
- Do not implement cc-2.1's embedded `argv0='rg'` dispatch in the Electron
  executable. Use a packaged ripgrep binary now; embedded dispatch can be a
  future native-build decision.

## Shape

This plan is shape (a): one complete feature in one PR.

The implementation is complete only when the app no longer depends on a
user-installed `rg` for the local search surfaces listed above, and tests cover a
PATH that deliberately omits system ripgrep.

## Source Findings

- A real General-channel run produced `file_grep` failures with
  `ripgrep_unavailable` and `spawn rg ENOENT`.
- The current agent implementation directly invokes `rg` from
  `src/main/agentLocalTools.ts` for `file_grep` and the `file_glob` fast path.
- The main process also directly invokes `rg` in `src/main/main.ts` for local
  filename search fallback.
- cc-2.1 centralizes search execution in `src/utils/ripgrep.ts`:
  `ripgrepCommand()` chooses system, bundled, or embedded ripgrep; GrepTool calls
  that helper instead of `spawn('rg')`; Bash shell setup also makes `rg`
  available when the system does not provide it.

## Requirements

- FR-1: `file_grep` resolves ripgrep through a Tenon-owned provider and succeeds
  when the process `PATH` does not contain a system `rg`.
- FR-2: `file_glob` uses the same provider for its ripgrep candidate path while
  preserving the existing TypeScript directory-walk fallback.
- FR-3: Main-process local filename search uses the shared provider instead of a
  bare `spawn('rg', ...)` call.
- FR-4: Agent Bash subprocesses can discover a bundled `rg` through PATH when no
  system ripgrep is available, without shadowing an existing user/system `rg`.
- NFR-1: Packaged Tenon includes a working ripgrep resource with recorded
  version and license provenance.
- NFR-2: Missing Poppler or MarkItDown behavior remains unchanged in this plan.

## Collision Result

- `gh pr list` returned no open PRs at plan time.
- `docs/TASKS.md` has historical notes that pre-existing `agentLocalTools` tests
  failed when `rg` was absent, but no active plan owns the fix.
- Expected touched areas:
  - `src/main/agentRipgrep.ts` or equivalent new resolver module
  - `src/main/agentToolProcess.ts`
  - `src/main/agentLocalTools.ts`
  - `src/main/main.ts`
  - `package.json` / `bun.lock` only if the chosen bundled-ripgrep delivery path
    uses a dependency instead of checked-in vendor artifacts
  - `build/afterPack.cjs` and `package.json` build `extraResources` if packaged
    resources need explicit inclusion or executable-bit repair
  - `tests/core/agentLocalTools.test.ts` plus focused resolver tests
  - `docs/spec/agent-tool-design.md` and `docs/spec/agent-progress.md`

## Design

### Dependency Audit

| Dependency | Current usage | Failure mode | Decision |
|---|---|---|---|
| `rg` / ripgrep | Agent `file_grep`, `file_glob` fast path, main local filename search | Hard `spawn rg ENOENT` for `file_grep`; silent empty search in main fallback | Bundle and resolve through a Tenon-owned provider. |
| Poppler: `pdfinfo`, `pdftotext`, `pdftoppm` | Agent PDF metadata/text/page reads; asset PDF thumbnail derivation | Recoverable PDF tool error, or optional thumbnail omission | Keep external for this plan. It is a multi-binary conversion dependency and already has explicit recovery guidance. |
| MarkItDown | Rich document Markdown ingestion | Recoverable rich-document read error | Keep external for this plan. It has `LIN_AGENT_MARKITDOWN_COMMAND`, probe caching, and installation guidance. |
| `sips`, `soffice` / `libreoffice` | Suggested conversion commands exposed to Bash, not core local search | Command failure if user asks for conversion and dependency is absent | Out of scope. |
| `mdfind`, `osascript`, `taskkill`, `git`, `codesign` | Platform or development helpers | Platform-specific fallback or development failure | Out of scope unless a call blocks the ripgrep package path. |

### Ripgrep Provider

Add one main-process provider module, named `agentRipgrep.ts` unless the dev finds
a better local convention. It should export a small typed API:

```ts
type RipgrepMode = 'env' | 'bundled' | 'system';

interface ResolvedRipgrepCommand {
  command: string;
  argsPrefix: string[];
  mode: RipgrepMode;
  binDir?: string;
  source: string;
}
```

Resolution order:

1. `LIN_AGENT_RIPGREP_COMMAND`, for tests, local debugging, and emergency user
   override. It may be a bare executable or a command with fixed prefix args.
2. Bundled ripgrep, preferred by default:
   - dev/source path pattern: `vendor/ripgrep/{arch}-{platform}/rg`
   - packaged path pattern:
     `process.resourcesPath/ripgrep/{arch}-{platform}/rg`
   - Windows keeps `.exe` naming if future Windows packaging is enabled.
3. System `rg` as a best-effort fallback, so development builds remain usable if
   the vendor artifact is missing. This fallback must not be the default packaged
   success path.

The provider should probe `--version` once per process and cache the result. A
failed probe should include the attempted source and mode in the error so
diagnostics point at the missing app resource rather than telling the user to
install Homebrew.

### Bundled Artifact

Add a tracked vendor artifact or a deterministic dependency-backed copy step. The
implementation path is acceptable if it satisfies all of these constraints:

- The app can locate a real `rg` binary in dev without relying on Homebrew.
- `electron-builder` includes the same binary under app resources.
- The binary keeps executable permissions after checkout and packaging.
- The source/version/license are recorded next to the artifact, for example in
  `vendor/ripgrep/README.md`.
- `bun run app:build` signs the final app bundle with the existing afterPack
  hook. If the resource needs extra chmod or signing treatment, keep it in the
  packaging step, not at runtime.

Use ripgrep 15.x unless there is a concrete compatibility reason to choose a
different version.

### Search Tool Wiring

- `file_grep` must call the provider and execute `{ command, argsPrefix + args }`
  instead of `runProcessLinesPage('rg', ...)`.
- `file_glob`'s fast path must also use the provider. Its existing pure
  TypeScript fallback remains in place if ripgrep is unavailable or times out.
- The main local filename search fallback in `main.ts` must use the same provider
  instead of `spawn('rg', ...)`.
- Local tool subprocess PATH should include the bundled ripgrep `binDir` after
  user/system PATH, so Bash commands can still find `rg` when no system ripgrep
  exists. Dedicated tools should still call the explicit resolved command.
- Keep `file_grep` output modes, relative path behavior, context flags, glob/type
  filters, offset pagination, and stderr bounding unchanged.

### Error Semantics

After this change, `ripgrep_unavailable` should mean Tenon's bundled/search
provider is broken or inaccessible, not that the user needs to install `rg`.

Update the recovery text accordingly:

- Explain which provider mode failed.
- Tell the agent to retry with `file_glob` only when it is doing path discovery
  and the TypeScript fallback can answer.
- For `file_grep`, do not instruct the agent to install ripgrep as the primary
  remediation. This is a product packaging/runtime issue.
- Preserve `ripgrep_failed` for bad regex, bad type/glob flags, or true ripgrep
  usage errors.

### Spec Sync

Update `docs/spec/agent-tool-design.md`:

- `file_grep` is ripgrep-backed through Tenon's bundled ripgrep provider.
- `file_glob` may use the same provider for candidate enumeration but has a
  TypeScript fallback.
- Missing `rg` on the user's shell PATH is no longer expected to break these
  tools.

Update `docs/spec/agent-progress.md` so the checklist no longer claims that
ripgrep is merely found through `LIN_AGENT_EXTRA_TOOL_PATH` and standard PATH
segments.

Do not change the Poppler or MarkItDown spec commitments except to clarify that
they are separate optional conversion dependencies.

## Acceptance Criteria

- AC-1: With `PATH` set to a directory list that does not contain `rg`,
  `file_grep` can find matches through the bundled/provider ripgrep.
- AC-2: With `PATH` set to a directory list that does not contain `rg`,
  `file_glob` still returns matches and its ripgrep fast path is covered by a
  fake or bundled provider test.
- AC-3: The main local filename search fallback no longer contains a bare
  `spawn('rg', ...)` call and uses the shared provider.
- AC-4: A Bash command that runs `command -v rg` can find the bundled `rg` when
  system ripgrep is absent, without putting the bundled path before an existing
  user/system `rg`.
- AC-5: `ripgrep_unavailable` tests assert the new packaging/runtime guidance,
  not package-manager installation guidance.
- AC-6: `bun run typecheck`, `bun run test:core`, and `bun run docs:check` pass.
- AC-7: `bun run app:build` includes the ripgrep resource in the packaged app.
  If the dev cannot run the full packaged build, they must at least run the
  packaging/resource unit or script check and state the remaining manual check in
  the PR.

## Implementation Tasks

- [ ] 1. Add the ripgrep provider and vendor path resolution.
  - Covers AC-1, AC-4, AC-5, AC-7.
  - Verification: unit tests with `LIN_AGENT_RIPGREP_COMMAND` and an empty PATH.

- [ ] 2. Wire agent `file_grep` and `file_glob` to the provider.
  - Covers AC-1, AC-2, AC-5.
  - Verification: focused `agentLocalTools` tests that previously skipped when
    real `rg` was absent should now run against the provider path where possible.

- [ ] 3. Wire main local filename search to the provider.
  - Covers AC-3.
  - Verification: unit-test the helper if it can be extracted cleanly; otherwise
    add a small injectable seam and test that it passes provider command/args.

- [ ] 4. Expose bundled ripgrep to local Bash PATH without shadowing system `rg`.
  - Covers AC-4.
  - Verification: test `buildAgentLocalToolProcessEnv` with a fake bundled
    `binDir` and no system `rg` segment.

- [ ] 5. Package and document the bundled binary.
  - Covers AC-7.
  - Verification: inspect app resources after build or add a deterministic build
    script check.

- [ ] 6. Sync specs and recovery instructions.
  - Covers AC-5, AC-6.
  - Verification: `bun run docs:check`.

## Open Questions

None blocking. The implementing dev may choose checked-in vendor artifacts or a
dependency-backed copy step, but the PR must satisfy the bundled-artifact
constraints above and must not rely on Homebrew for the packaged app.
