# Agent Tool Reliability

Two observation tools currently turn recoverable input or request-construction
problems into dead research paths. Every `web_fetch` call fails before reaching
the network because Chromium rejects a navigation-only request header on
Electron's Fetch API. `file_read` accepts `pages` in its shared schema but fails
the entire read when the target is not a PDF, even though the parameter is only
an irrelevant selector for that file type. This plan repairs both failures in
one reliability change.

## Goal

- Restore `web_fetch` for ordinary HTTP(S) URLs in both development and packaged
  builds, with a real Electron request probe that catches request-construction
  failures.
- Make an accidental non-PDF `pages` argument non-fatal: read the file normally
  and tell the model that the selector was ignored.
- Keep PDF page selection and every existing fetch/read result contract intact.

## Non-goals

- No new model tools, parameters, permissions, or protocol types.
- No redesign of web challenge handling, redirects, browser fallback, file
  ingestion, or PDF rendering.
- No retry workaround for deterministic request-construction failures.
- No generic silent coercion of invalid required arguments. Tolerance applies
  only to the optional `pages` selector when it cannot affect a non-PDF read.

## Design

Shape **(a)**: one complete agent-tool reliability fix in one PR. The two repairs
ship and verify together as requested; neither is left as groundwork for later
work.

### Web fetch request construction

- Stop setting `Sec-Fetch-Mode: navigate` on `Session.fetch`. A Fetch API
  request is not a browser navigation, and Chromium rejects that value with
  `net::ERR_INVALID_ARGUMENT` before any URL is contacted. Keep the existing
  browser identity, content negotiation, redirect policy, referrer policy, and
  other accepted request headers.
- Put the request-header builder behind a pure, focused module so unit tests pin
  the legal first-hop and redirect-hop shapes without importing Electron.
- Repair `probe:web-tools` after the tool-envelope module move. Add a local HTTP
  fixture probe so the real Electron `Session.fetch` path is deterministic and
  does not need public-network availability to catch this class of regression;
  retain public probes for end-to-end reachability.

### Tolerant non-PDF page selection

- Keep `pages` validation and rendering unchanged for `.pdf` files.
- For every non-PDF route, discard the optional selector after resolving the
  file type and attach one model-visible warning to the successful result. The
  warning names `offset` / `limit` for text pagination and does not pretend that
  other document formats support page selection.
- Strengthen the tool and parameter descriptions with `PDF files only` at the
  point where the model chooses arguments. The runtime tolerance remains the
  correctness boundary because guidance alone has already failed repeatedly.
- Carry the warning through image, notebook, Office/rich-document, unchanged,
  and ordinary-text success results so behavior does not depend on file type or
  cache state.

### Files and collision result

- Runtime: `src/main/agent/capabilities/agentTools.ts`,
  `agentWebFetchRequest.ts`, and `agentLocalTools.ts`.
- Probe and tests: `scripts/probe-web-tools.ts`,
  `tests/core/agentWebFetchRequest.test.ts`, and
  `tests/core/agentLocalTools.test.ts`.
- Current behavior: `docs/spec/agent-tool-design.md`.
- Collision self-check on 2026-08-08: open PR #505 and the active board do not
  claim or modify these files or areas.

## Open questions

None. The PM selected one PR, and the reported behavior fixes determine the two
runtime decisions above.

## Verification

- [ ] The real Electron probe fetches a local HTML page in read, metadata, and
  find modes without `ERR_INVALID_ARGUMENT`.
- [ ] A normal non-PDF `file_read` with `pages` succeeds, returns content, and
  exposes exactly one ignored-parameter warning.
- [ ] PDF page selection remains covered by its existing rendering tests.
- [ ] `bun run typecheck`, `bun run test:core`, and `bun run docs:check` pass.
