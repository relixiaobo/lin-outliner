# Agent Tool Reliability

Two observation tools currently turn recoverable input or request-construction
problems into dead research paths. `web_fetch` constructs an invalid Fetch API
request, while Electron's manual redirect mode also rejects common redirecting
URLs before their landing content can be read. `file_read` accepts `pages` in
its shared schema but fails the entire read when the target is not a PDF, even
though a valid selector is irrelevant for that file type. This plan repairs both
failures in one reliability change.

## Goal

- Restore `web_fetch` for ordinary HTTP(S) URLs in both development and packaged
  builds, including redirecting URLs, with a real Electron request probe that
  catches request-construction and redirect regressions.
- Make an accidental non-PDF `pages` argument non-fatal: read the file normally
  and tell the model that the selector was ignored.
- Keep valid PDF page selection and every existing fetch/read result contract
  intact.

## Non-goals

- No new model tools, parameters, permissions, or protocol types.
- No redesign of web challenge handling, browser fallback, extraction, file
  ingestion, PDF rendering, or redirect trust and hint contracts.
- No retry workaround for deterministic request-construction failures.
- No generic silent coercion of invalid arguments. Tolerance applies only to a
  valid optional `pages` string when it cannot affect a non-PDF read; malformed
  values remain `invalid_args`.

## Design

Shape **(a)**: one complete agent-tool reliability fix in one PR. The two repairs
ship and verify together as requested; neither is left as groundwork for later
work.

### Web fetch request construction

- Leave the complete `Sec-Fetch-*` metadata set to Chromium. A `Session.fetch`
  request is not a browser navigation: forcing navigation-only values either
  rejects it with `net::ERR_INVALID_ARGUMENT` or creates a contradictory Fetch
  Metadata tuple. Keep the accepted user agent, client hints, and content
  negotiation headers.
- Use `redirect: 'follow'` because Electron 42 cancels `Session.fetch` requests
  in manual redirect mode. Electron leaves `Response.url` empty on this path, so
  observe `webRequest.onBeforeRedirect` on the dedicated fetch session to retain
  the actual landing URL for the existing final-URL result and cross-host hint.
- Put request construction and redirect tracing behind a focused module. Unit
  tests pin the accepted header shape without importing Electron; the runtime
  trace stays scoped to the dedicated session and request lifetime.
- Repair `probe:web-tools` after the tool-envelope module move. Add a local HTTP
  fixture probe so the real Electron `Session.fetch` path is deterministic and
  does not need public-network availability to catch this class of regression.
  The fixture includes a real 302 and rejects contradictory Fetch Metadata.
  Fixture setup and teardown are reported like other probes, public checks use
  stable page signals, tool-owned BrowserWindow closure cannot end the probe,
  and process exit preserves the complete summary when output is redirected.
  A final expected-name check makes an omitted, duplicated, or unplanned probe
  an explicit failure rather than a partial green run.

### Tolerant non-PDF page selection

- Require `pages`, when present, to be a non-empty string before dispatching any
  file route. This runtime validation matches the schema and prevents a malformed
  PDF selector from being silently dropped. Valid PDF range validation and page
  rendering stay unchanged.
- For every non-PDF route, discard a valid optional selector after resolving the
  actual content route and attach one model-visible warning to the successful
  result. The warning recommends `offset` / `limit` only for text and accurately
  states the pagination behavior of images, notebooks, presentations, and rich
  documents.
- Strengthen the tool and parameter descriptions with `PDF files only` at the
  point where the model chooses arguments, and state that omitting `pages`
  extracts PDF text by default. The runtime boundary remains authoritative
  because guidance alone has already failed repeatedly.
- Carry the warning through image, notebook, Office/rich-document, unchanged,
  and ordinary-text success results so behavior does not depend on file type or
  cache state.

### Files and collision result

- Runtime: `src/main/agent/capabilities/agentTools.ts`,
  `agentWebFetchRequest.ts`, `agentWebFetchFallback.ts`,
  `agentWebConstants.ts`, `agentWebTools.ts`, and `agentLocalTools.ts`.
- Probe and tests: `scripts/probe-web-tools.ts`,
  `tests/core/agentWebFetchRequest.test.ts`,
  `tests/core/agentWebFetchFallback.test.ts`,
  `tests/core/agentLocalTools.test.ts`, and the canonical tool-catalog snapshot.
- Current behavior: `docs/spec/agent-tool-design.md`.
- Collision self-check on 2026-08-08: open PR #505 and the active board do not
  claim or modify these files or areas.

## Open questions

None. The PM selected one PR, and the reported behavior fixes determine the two
runtime decisions above.

## Verification

- [ ] The real Electron probe fetches a local HTML page in read, metadata, and
  find modes, follows a real 302 to the reported landing URL, and observes a
  Chromium-consistent Fetch Metadata set without `ERR_INVALID_ARGUMENT`.
- [ ] A normal non-PDF `file_read` with `pages` succeeds, returns content, and
  exposes exactly one route-specific ignored-parameter warning.
- [ ] A non-string or blank `pages` value fails with `invalid_args`, while an
  omitted selector still extracts PDF text by default.
- [ ] PDF page selection remains covered by its existing rendering tests.
- [ ] Redirected probe output contains the complete trailing summary and retains
  the correct exit code.
- [ ] The BrowserWindow-backed search runs before later fetch probes, and closing
  its window cannot terminate the process before every expected probe is recorded.
- [ ] `bun run typecheck`, `bun run test:core`, and `bun run docs:check` pass.
