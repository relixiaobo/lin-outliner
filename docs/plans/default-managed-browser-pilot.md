# Default Managed Browser Pilot

## Goal

Make Browser Pilot available to every eligible Tenon installation without asking
the user to install its Skill first. Browser Pilot remains an ordinary `managed`
Skill, is acquired and enabled by default, and continues to use the public
integration path owned by Browser Pilot:

```text
Agent -> browser-pilot Skill -> bash -> bp CLI -> Chrome
```

The `bp` CLI is not installed at app startup. On the first relevant task, the
Skill preflight reuses a compatible command or installs the exact tested native
release through the normal `bash` capability path. On Apple Silicon macOS this
requires no separately installed Node.js or npm. Skill updates continue through
GitHub; CLI updates continue through the Skill's version contract and pinned
GitHub Releases, with npm retained only as the upstream unsupported-platform
fallback.

This is shape **(a): one complete feature in one PR**. Default acquisition,
opt-out persistence, runtime environment isolation, update behavior, specs, and
verification ship together.

## Non-goals

- Do not register Browser Pilot as a code or resource-backed `built-in` Skill.
- Do not change any Linlab catalog Skill from opt-in to default-acquired.
- Do not bundle the Browser Pilot Skill bytes, native executable, Node.js, npm,
  or a product-owned `bp` launcher in Tenon.
- Do not implement a Tenon-owned Browser Pilot downloader, release-index parser,
  installer, component updater, or CLI cleanup service.
- Do not add Browser Pilot model tools, an MCP server, SDK wrapper, browser
  extension, native command provider, protocol adapter, or persistent client.
- Do not auto-apply managed Skill updates or install/update the CLI outside an
  Agent task.
- Do not add Browser Pilot-specific permission rules or bypass Configuration
  Profile Skill/tool ceilings, explicit capability blocks, or ordinary `bash`
  classification.
- Do not make screenshots, PDFs, downloads, or saved network bodies durable
  Thread resources. They remain Turn-owned scratch files under the existing TTL.
- Do not manage Chrome's remote-debugging preference, suppress Chrome's Allow
  dialog, close user-owned tabs at Turn completion, or disconnect shared Browser
  Pilot state automatically.
- Do not remove an installed CLI or stop its shared service when the managed
  Skill is disabled, uninstalled, rolled back, or absent from one configuration.

## Design

### Purpose And Current Evidence

This changes acquisition defaults, not Browser Pilot's authority or runtime
shape. The current product already has every downstream managed lifecycle state;
the missing behavior is an idempotent product-default admission before the first
Skill catalog snapshot.

- **EVD-1:** `catalog/managed-skills-v1.json` already recommends
  `browser-pilot`, but tracks `main` and requires a user-initiated Add flow.
- **EVD-2:** The managed store already pins immutable Git commits and complete
  subtree hashes, validates content before publication, works offline after
  installation, and supports disable, update preview/apply, rollback, and
  uninstall.
- **EVD-3:** Browser Pilot `skill-stable` v0.6.1 publishes the managed-host
  contract: install only the complete Skill, then let its mandatory preflight
  reuse a compatible `bp` or install the exact tested native release. npm is
  attempted only after the native installer returns its dedicated unsupported-
  platform exit code; other native failures must not fall through to npm.
- **EVD-4:** The reviewed `skill-stable` commit is
  `853e95d26acec49bcb60d8dac3bb8e5060491727`. Tenon's current validator accepts
  its complete nine-file subtree (including both installer scripts) at content
  hash `bea2163ac5d51d8b0ec2b0c7d119dd23904079b0086bee087752eeef6aa86b6d`.
  Its compatibility contract tests CLI v0.6.1 and accepts `>=0.6.1 <1.0.0`.
- **ASM-1:** Existing managed state has no durable record of a past uninstall.
  The first release of this policy therefore treats an absent record as eligible
  once; after this feature ships, every default uninstall writes the durable
  opt-out before removal.

### Decisions And Constraints

- **DEC-1:** Browser Pilot has `source: managed` everywhere. Its Settings row,
  enable predicate, update preview, rollback, and uninstall behavior use the same
  managed-Skill paths as the Linlab catalog entries.
- **DEC-2:** Tenon owns only the default-acquisition policy. Browser Pilot owns
  its instructions, CLI compatibility range, exact native repository/version and
  installer paths, npm fallback contract, setup, browser operation, waiting, and
  recovery semantics.
- **DEC-3:** Initial default acquisition is release-pinned. A checked-in host
  manifest names the catalog identity, repository, subdirectory,
  `skill-stable` tracking ref, reviewed v0.6.1 commit from EVD-4, and expected
  whole-subtree hash. Tenon downloads that immutable commit through the existing
  managed-Skill validator; it never installs the current tip of a mutable branch
  as a product default.
- **DEC-4:** Later Skill updates follow `skill-stable`, are detected by the
  existing ambient/explicit checks, and still require preview and explicit Apply.
  The catalog must not track Browser Pilot's development `main` branch. v0.6.1 is
  only the first reviewed seed, not a terminal Browser Pilot or CLI version; after
  each Apply, that active Skill's compatibility contract becomes authoritative.
- **DEC-5:** The managed Skill's mandatory preflight is the only CLI provisioner.
  It checks `command -v bp` and `bp --version`, accepts a compatible existing
  installation, and otherwise invokes the installer path, repository, and version
  declared in `compatibility.json`. The installer downloads the matching native
  archive plus SHA-256 sidecar, validates and extracts it, preserves the complete
  versioned release, and publishes owned `bp` and `browser-pilot` command links.
  It never substitutes GitHub `latest` or npm `@latest`.
- **DEC-6:** The initial v0.6.1 Skill uses the official native v0.6.1 release on
  Apple Silicon macOS and has no Node.js/npm prerequisite. A later applied stable
  Skill may name a newer tested release without a Tenon code change. The exact npm
  fallback is eligible only when the active Skill's native installer returns its
  declared unsupported-platform exit code; it still requires the Node.js version
  declared by that Skill. Download, checksum, extraction, command-conflict,
  filesystem, and PATH failures stop the browser task and never fall through to
  npm. Intel Mac remains unsupported by Browser Pilot.
- **DEC-7:** Tenon gives the upstream installer a durable, app-owned command
  location and makes that location the first Agent tool path:

  ```text
  BROWSER_PILOT_INSTALL_ROOT = join(userData, "browser-pilot")
  BROWSER_PILOT_BIN_DIR = join(BROWSER_PILOT_INSTALL_ROOT, "bin")
  PATH = BROWSER_PILOT_BIN_DIR + delimiter + existingAgentToolPath
  ```

  Both installer variables are present in Skill-shell, foreground `bash`, and
  background `bash` environments. Tenon does not edit the user's shell startup
  files or system PATH. A compatible user-installed command remains reusable when
  the dedicated directory is empty; after managed installation, the dedicated
  command wins over an incompatible unmanaged command elsewhere on PATH.
- **CON-1:** Installing a managed Skill remains inert. Default acquisition may
  download, validate, and store instruction/support bytes, including non-
  executable installer scripts, but it never executes Skill content or installs
  dependencies. Script execution occurs only in the first relevant Agent task.
- **CON-2:** Browser Pilot exposes the user's eligible signed-in browser surface
  and has no per-action approval layer. Default availability grants no new Tenon
  authority: invocation and every shell command remain inside the existing Full
  Access and explicit-block model, while Chrome retains its own connection
  authorization.
- **TRD-1:** A first installation without network may temporarily lack the default
  Skill, and a first browser task still needs GitHub access for the roughly 36 MB
  Apple Silicon archive. This is preferred to coupling Tenon's package and release
  cadence to Browser Pilot's executable distribution.
- **TRD-2:** Tenon pins and hashes the Skill, while the Skill-owned installer pins
  the CLI tag and verifies the archive against the release's SHA-256 sidecar.
  Tenon deliberately does not duplicate the release checksum or update logic in a
  second host manifest; CLI artifact trust remains with Browser Pilot's release
  channel.
- **TRD-3:** A legacy Browser Pilot installation outside Tenon's dedicated root
  may retain old command links and release data after Tenon installs its managed
  CLI. Leaving those user-global bytes untouched can consume extra disk space,
  but is preferred to Tenon guessing ownership and deleting or migrating another
  installer's data. Legacy cleanup belongs to Browser Pilot or an explicit user
  action.

### Default Acquisition And Failure Recovery

Default acquisition is a private managed-service policy, not a catalog schema
flag. Older Tenon versions must continue parsing the live catalog, and other
catalog entries must not inherit default behavior.

Tenon keeps a small private opt-out record beside the managed index. It answers
only whether automatic acquisition of a named product default has been declined;
it is not a second activation store and is never exposed to the model.

The one-attempt-per-launch bootstrap applies these business rules in order:

- **BR-1:** If a `browser-pilot` managed record already exists, preserve its
  active/previous versions, content hashes, diagnostics, and enabled state. A
  prior manual disable is authoritative. An official catalog record that still
  carries the former `main` tracking ref is rebound to `skill-stable` metadata
  only; an arbitrary manual source or ref is not rewritten.
- **BR-2:** If `browser-pilot` is in the default opt-out record, do nothing.
- **BR-3:** If a built-in, user, project, local-directory, or other managed Skill
  owns the same canonical name, preserve that owner and do not download another
  copy.
- **BR-4:** Otherwise download the release-pinned commit, run the ordinary
  managed validation/integrity pipeline, verify the expected subtree hash,
  install the content-addressed local copy, and atomically publish an enabled
  managed record.
- **BR-5:** A network, compatibility, validation, integrity, storage, or
  notification failure publishes no partial record, does not mark opt-out, and
  does not block app launch or unrelated Agent work. The next launch may retry
  once.
- **BR-6:** Successful uninstall writes opt-out before removing the index record.
  Disable preserves the record. Explicit manual install remains allowed without
  clearing opt-out, so a later uninstall remains final.

The bootstrap begins asynchronously during Agent-service startup and does not
block first paint. The first Skill-registry load joins the same bounded bootstrap
promise so a concurrent first Turn cannot snapshot the registry between content
promotion and index publication. Failure degrades to the ordinary catalog/manual
install path rather than failing Turn admission.

Uninstalling the product-default record writes the opt-out before removing the
managed index entry. If that write fails, uninstall stops before changing the
active record. A successful uninstall therefore cannot be reversed by the next
launch. Disabling retains the installed record and needs no opt-out. A later
explicit user install is allowed, but it does not erase the opt-out; a subsequent
uninstall remains final until the user explicitly installs again.

### FLOW-1: First Default Acquisition

- **Actor:** Tenon installation with no `browser-pilot` managed record or opt-out.
- **Entry path:** Agent-service startup.
- **Entry state:** The release-pinned default manifest is valid; network may be
  available or unavailable.
- **Mainline:** Resolve the immutable release pin, validate and hash the complete
  Skill subtree, publish it as an enabled managed record, refresh live Skill
  registries, and expose it through the normal catalog evidence.
- **Result state:** Settings shows one enabled Managed `/browser-pilot` row and
  eligible Agent configurations may invoke it.
- **Failure/recovery:** Preserve an absent state, record only bounded diagnostics,
  keep the app and unrelated Turns usable, and retry at most once on the next
  launch or allow the existing manual Add flow.

### FLOW-2: First Browser Task

- **Actor:** An Agent whose effective Skill and tool ceilings include
  `browser-pilot` and `bash`.
- **Entry path:** The model invokes the managed Skill for a browser task.
- **Entry state:** The Skill is installed and enabled; `bp` may be compatible,
  absent, or incompatible.
- **Mainline:** Read the active Skill's compatibility metadata, check the resolved
  command and version, invoke the exact native installer when required, re-resolve
  and re-check compatibility, inspect browser state, and continue through normal
  Browser Pilot commands. On an upstream-declared unsupported platform only, use
  the exact Node/npm fallback after its prerequisite check.
- **Result state:** A compatible CLI performs the task under the same capability
  decisions as any other shell command.
- **Failure/recovery:** Native download, checksum, extraction, ownership, PATH, or
  post-install compatibility failure stops without npm fallback. An eligible npm
  fallback may instead fail for missing Node/npm or installation errors. Either
  case, unavailable Chrome, or denied browser authorization stops browser work
  with concrete recovery guidance and leaves the managed Skill active.

### FLOW-3: Updates And User Control

- **Actor:** A user managing the Skill library, or an Agent beginning a later
  browser task.
- **Entry path:** Ambient/explicit managed update check, Skill toggle/uninstall,
  or Browser Pilot preflight.
- **Mainline:** GitHub updates are detected from `skill-stable`; the user previews
  and applies a pinned Skill commit; the next relevant task reconciles the CLI to
  that Skill's exact native release or declared fallback. Disable removes the Skill
  from model availability. Uninstall removes its content and records default
  opt-out, while leaving the independently reusable CLI installation intact.
- **Result state:** Skill and CLI may evolve independently but every task runs a
  pair accepted by the active Skill's declared range.
- **Failure/recovery:** Failed update checks or CLI upgrades retain the last clean
  Skill version and enabled choice. Rollback restores the prior Skill version;
  its next preflight may reconcile the CLI again.

### Agent Identity And Turn-Owned Output

Tenon satisfies Browser Pilot's host environment contract without adding a
Browser-specific tool:

```text
BROWSER_PILOT_INSTALL_ROOT = join(userData, "browser-pilot")
BROWSER_PILOT_BIN_DIR = join(BROWSER_PILOT_INSTALL_ROOT, "bin")
BROWSER_PILOT_CLIENT_KEY = "tenon." + base64url(sha256(installationId + ":" + threadId))
BROWSER_PILOT_OUTPUT_DIR = join(agentScratchRoot, "browser-pilot", threadId, turnId)
```

- The durable install root and bin directory are shared by all Threads in one
  isolated Tenon `userData`; the bin directory is prepended to their Agent PATH.
  Tenon does not set `BROWSER_PILOT_HOME`, so protocol-compatible installations
  continue to reuse Browser Pilot's normal per-user service.
- One Thread reuses its client key across Turns; root Threads, forks, child
  Threads, isolated-Skill Threads, and concurrent independent Threads receive
  distinct keys.
- The key contains no personal data or secret, remains host-only, and is not
  persisted in model arguments, Thread Items, transcripts, or diagnostics.
- The Turn output directory is created and canonicalized before an Agent shell
  process starts. Browser Pilot rejects explicit output escapes while the
  variable is present; Tenon's normal file capabilities govern later reads.
- Every Skill-shell, foreground, and background `bash` process in the Turn
  receives the same Browser Pilot environment. Retry recovery therefore preserves
  command resolution, client state, and output scope.
- Tenon does not set a task-wide `BROWSER_PILOT_REQUEST_ID`; operation request IDs
  remain Browser Pilot's per-command concern.
- Turn completion leaves Browser Pilot client/browser state intact. Scratch TTL
  cleanup reclaims output files through the existing app-owned lifecycle.

### Settings And Source Semantics

The successful default appears exactly like any other recommended managed Skill:

- source chip: Managed;
- initial state: enabled;
- controls: enable/disable, check/preview/apply update, rollback, and uninstall;
- runtime identity: pinned commit plus whole-subtree content hash;
- update source: `relixiaobo/browser-pilot`,
  `plugin/skills/browser-pilot`, `skill-stable`.

There is no Default or Built-in badge and no special Browser Pilot settings
surface. Configuration Profiles and Roles may still omit the Skill, an explicit
`disabledSkills` choice still wins, and disabling `bash` makes the workflow
unusable without changing the Skill row's source.

Linlab recommendations retain their current manual Add behavior. The packaged
built-in floor remains unchanged.

### Implementation Boundary

The implementation should remain inside the current managed-Skill and generic
shell seams:

- `catalog/managed-skills-v1.json`: track `browser-pilot` from `skill-stable`.
- a new main-owned default manifest/policy module: release pin, expected hash,
  default identity, and bootstrap orchestration inputs;
- `src/main/managedSkillStore.ts` and `src/main/managedSkillService.ts`: private
  opt-out state, idempotent default acquisition, ordinary install validation,
  narrow official-origin rebinding, atomic publication, and uninstall ordering;
- `src/main/main.ts`: start/join bootstrap, refresh registries, derive the durable
  install paths and per-Thread identity, and bind Turn output roots;
- `src/main/agent/capabilities/agentToolPath.ts`, `agentToolProcess.ts`,
  `agentLocalTools.ts`, and `agentSkillShell.ts`: prepend the dedicated command
  directory and carry the host-owned Browser Pilot environment into Skill-shell,
  foreground, and background process creation;
- focused managed store/service/catalog/local-tool/runtime tests;
- `docs/spec/agent-skills.md`, `docs/spec/agent-tool-permissions.md`, and the
  scratch/workspace spec that owns Turn output roots.

No `src/core/types.ts`, `src/core/commands.ts`, renderer IPC, Settings component,
package dependency, Electron `extraResources`, or Agent tool/protocol change is
required. If implementation evidence disproves that boundary, stop and re-ratify
the expanded contract rather than widening the PR silently.

### Collision Result And Ordering

The plan-only change touches no file in the currently open PRs. Implementation
has real overlap and must be ordered after this claim lands:

- PR #488 changes managed install semantics, `managedSkillService.ts`,
  `agentSkills.ts`, `main.ts`, Skill specs, Settings behavior, and focused tests.
  This feature builds on its install-enabled and instant-settings result rather
  than carrying a parallel version.

PRs #483, #490, and #491 are merged into the branch baseline. Their canonical
shell-history and app-owned scratch contracts are inputs to this plan rather than
open collisions. PR #480 has no file overlap. Re-run `gh pr list` and derive the
implementation queue from actual open-PR files immediately before build work.

## Open Questions

None. Browser Pilot v0.6.1 resolves the initial provisioning choice: the accepted
target is remote release-pinned managed Skill acquisition plus its upstream
native-first lazy installer. It remains a seed rather than a final version;
future releases advance through `skill-stable` and the active Skill's version
contract. Tenon supplies deterministic host paths and runtime identity/output
environment, but owns neither installer nor executable bytes.

## Acceptance And Verification

- [ ] **AC-1:** On an eligible installation with no record or opt-out, successful
      bootstrap creates exactly one enabled `managed` `browser-pilot` record from
      the reviewed commit/hash; no built-in definition or packaged Skill copy
      exists.
- [ ] **AC-2:** An existing enabled or disabled managed record preserves its
      active/previous versions, content hashes, diagnostics, and user choice. Only
      an official catalog record's obsolete `main` tracking ref is rebound to
      `skill-stable`; arbitrary manual origins and refs remain unchanged.
- [ ] **AC-3:** A user/project/local/built-in name owner prevents default
      acquisition without being replaced, rewritten, or disabled.
- [ ] **AC-4:** Network, compatibility, validation, hash, storage, or notification
      failure publishes no partial record, does not mark opt-out, does not block
      first paint or unrelated Agent work, and performs no unbounded same-launch
      retry.
- [ ] **AC-5:** Disable persists across restart. Successful uninstall records
      opt-out before removing the active record, and later launches do not
      reacquire it. Explicit manual installation remains possible.
- [ ] **AC-6:** The catalog, new default records, and normalized existing official
      records track `skill-stable`; update checks do not auto-download or
      auto-apply a later Skill version, and preview/apply/rollback retain their
      existing integrity guarantees.
- [ ] **AC-7:** A compatible existing `bp` outside Tenon's dedicated directory
      causes no install. An incompatible legacy command in `~/.local/bin`,
      Homebrew, or another external directory is neither overwritten, moved, nor
      deleted: on Apple Silicon the active Skill's exact native installer targets
      Tenon's dedicated root/bin, validates the published SHA-256, preserves a
      complete versioned release, resolves the initial v0.6.1 CLI ahead of that
      legacy command, and never follows GitHub `latest` or npm `@latest`. No
      Node.js/npm is required for that initial native release.
- [ ] **AC-8:** Only the declared unsupported-platform exit code permits the exact
      Node.js 22+/npm fallback. An unmanaged `bp` or `browser-pilot` entry inside
      Tenon's dedicated bin directory produces `command_conflict` and is not
      overwritten. That conflict, download, checksum, extraction, filesystem,
      PATH, and incompatible post-install failures never fall through to npm and
      produce bounded, actionable task failure without corrupting, disabling, or
      updating the managed Skill record.
- [ ] **AC-9:** The same Thread receives one stable client key across Turns;
      root, fork, child, isolated, and concurrent Threads receive distinct keys.
      Keys and injected environment values never enter durable/model-visible
      history.
- [ ] **AC-10:** Each Turn receives a canonical private output directory under
      Agent scratch; foreground/background shell calls agree on it, traversal or
      symlink escape is rejected, file tools can consume valid outputs, and TTL
      cleanup reclaims them.
- [ ] **AC-11:** Skill and tool ceilings, explicit disablement, capability blocks,
      Chrome connection authorization, and user-owned tab lifetime remain
      unchanged. No Browser Pilot-native model/tool/runtime surface is added, and
      Tenon neither sets a private service home nor stops the shared service.
- [ ] **AC-12:** Other catalog Skills remain opt-in and the packaged built-in floor
      remains unchanged.
- [ ] Run `bun run typecheck`, `bun run test:core`, `bun run test:renderer`, the
      focused managed-Skill/local-shell tests, `bun run docs:check`, and
      `git diff --check`.
- [ ] Run one disposable real-browser smoke with isolated `userData` and no Node/npm
      on the test PATH: clean default acquisition, exact native CLI provisioning,
      command-path precedence, Chrome authorization, two Turns reusing one Thread
      client, a second Thread using a distinct client, bounded screenshot output,
      disable persistence, uninstall opt-out, and manual reinstall. Separately
      fixture a compatible external command that is reused, an incompatible
      external legacy command that remains byte-for-byte unchanged while the
      dedicated CLI wins, an unmanaged dedicated-bin conflict that fails closed,
      checksum failure, unsupported-platform fallback, and `path_ready=false`
      without downloading release assets again.

## Subtasks

- Land/rebase the declared dependencies and re-run the collision queue from open
  PR file scopes.
- Pin the current `skill-stable` release commit/hash and change the catalog
  tracking ref.
- Add private default-policy/opt-out storage and idempotent bootstrap through the
  existing managed validation and mutation transaction.
- Bind the durable installer root/bin, stable Thread client identity, canonical
  Turn output roots, and command-path precedence into Skill-shell and generic
  foreground/background shell environments.
- Add failure, concurrency, persistence, update, and boundary tests; then fold
  the shipped design into the owning specs in the same implementation PR.
