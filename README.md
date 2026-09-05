# Tenon

Local-first structured thinking and agent workbench with an Electron shell, a
TypeScript core, and a React renderer. Loro CRDT under the hood. It uses an
outliner-shaped interface, but the product is aimed at structuring context,
directing local agents, and keeping work inspectable.

> Status: pre-release, single-developer project. Public so others can read the
> code and follow along.

## What's interesting in here

- **TypeScript-only stack.** No Rust, no Tauri, no `src-tauri`. Document state,
  agent runtime, tools, parsing, validation, and persistence are all
  TypeScript across `src/core`, `src/outline`, `src/content`, and `src/main`.
- **Loro-backed document model** with patch-based rich text
  (`RichTextPatchOp`) so concurrent edits compose cleanly when sync arrives.
- **Runtime-owned document mutations.** Desktop and CLI clients submit public
  ChangeSets to the standalone Outline Runtime, which owns Core commands,
  Operation history, and document persistence. Scoped undo keeps user and Agent
  edits separate.
- **Local agent.** An in-app dock with a Tenon-native turn runtime backed by
  [pi-ai] for provider catalogs, authentication, and transport, plus
  file/bash/web tools, skills, subagents, and event-sourced Threads and Turns.
  Available tools run under Full Access with explicit capability blocks; see
  [`docs/spec/agent-tool-permissions.md`](docs/spec/agent-tool-permissions.md).
  Runtime and presentation contracts live in
  [`docs/spec/agent-core.md`](docs/spec/agent-core.md) and
  [`docs/spec/agent-thread-rendering.md`](docs/spec/agent-thread-rendering.md).

## Repo Layout

```txt
src/
  core/      TypeScript outliner state machine, command list, search engine.
  content/   Shared exact-revision content admission, retention, and storage.
  outline/   Public contracts, standalone Runtime, CLI, clients, and imports.
  main/      Electron native hosts, Runtime adapter, agent runtime, and tools.
  preload/   Narrow Electron preload bridge exposed as `window.lin`.
  renderer/  React UI, outliner views, agent dock.
tests/
  core/      Pure TS tests against the core.
  renderer/  Renderer unit tests.
  e2e/       Playwright end-to-end tests.
docs/
  spec/      Current intended behavior. Read these to understand the code.
  plans/     Active designs; reference/ holds standing decisions and archive/
             preserves terminal plans.
```

## Development

```sh
# Install with the repository's package manager.
bun install

# Run the main clone with isolated development data.
bun run dev:main

# Run the renderer only against a stub document (useful for UI work).
bun run renderer:dev

# Type-check.
bun run typecheck

# Tests.
bun run test:core
bun run test:renderer
bun run test:e2e           # Playwright; needs the dev app to start

# Validate documentation links and lifecycle structure.
bun run docs:check

# Build a packaged macOS DMG.
bun run app:build
```

## Documentation

Everything that's intentional about how this code is shaped lives under
[`docs/spec/`](docs/spec/README.md). Start there. Plans for work that hasn't
landed yet live under [`docs/plans/`](docs/plans/); the active-plan index is on
[`docs/TASKS.md`](docs/TASKS.md).

The most useful entry points:

- [`docs/spec/architecture.md`](docs/spec/architecture.md) — runtime
  boundaries (core / main / preload / renderer).
- [`docs/spec/commands.md`](docs/spec/commands.md) — the IPC command surface.
- [`docs/spec/ui-behavior.md`](docs/spec/ui-behavior.md) — outliner
  interaction model.
- [`docs/spec/outliner-parity-matrix.md`](docs/spec/outliner-parity-matrix.md) —
  pointer/keyboard/trigger parity with nodex, plus the tests pinning each
  row.
- [`docs/plans/reference/nodex-parity-decisions.md`](docs/plans/reference/nodex-parity-decisions.md) —
  what we did and didn't carry over from nodex, with rationale.

## License

[MIT](LICENSE).

[pi-ai]: https://www.npmjs.com/package/@earendil-works/pi-ai
