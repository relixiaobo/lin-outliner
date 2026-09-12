# Error Observability

Tenon records runtime failures locally as structured diagnostics. The subsystem is
local-only: it never sends diagnostics to a server, never shows proactive badges,
toasts, or interruption prompts, and exposes only passive find/send actions in
Settings. Capability startup availability is a separate, in-memory owner surface;
its issue notices are not diagnostic-log notifications.

## Startup issues

The lifecycle retains scrubbed issue messages (at most 1,000 characters) and
copyable details (at most 8,000 characters) in Host memory. Oversized raw evidence
is omitted before truncation; complete and incomplete private-key material passes
through the existing secret scanner. Diagnostics persistence and event-observer
failure cannot hide the original issue or change readiness.

Issues name their domain, operation, observed category, optional Thread source,
and eligible actions. Error codes (including Node SQLite primary result codes)
separate permissions, full storage, locks, and invalid data. Snapshot readers alone
establish a version mismatch and its found/expected versions; unknown prose stays
unknown. Dependency availability follows the lifecycle DAG without duplicating a
source failure as a second corruption report.

Only the main renderer may request an action for a currently retained issue.
Native Copy details uses that retained text; Open source resolves a fixed owner
configuration destination inside the resolved data root. The request carries no
arbitrary path or reset instruction. Retry is lifecycle-owned and entity quarantine
has no cosmetic retry. Failed configuration bytes, workspace data, conversation
records, and Project metadata are preserved.

Unreadable Thread issues also expose a bounded recovery surface. The issue names
the exact Thread and descendants found through trusted catalog lineage. The Host
can return inspection, a verified rebuild, or an exact removal preview; it never
accepts a renderer path or arbitrary reset target. Native confirmation is bound
to the inspection digest. Retained originals and a restartable operation remain
available after an interruption, while a stale scope or unresolved owner blocks
the action. A successful removal or rebuild clears the session quarantine only
after owner cleanup or staged-reader verification completes.

## Reporting

The main process owns the reporting choke point:

```ts
reportError({ domain, severity, code?, message, context?, error? })
```

`domain` identifies the subsystem (`memory`, `command`, `agent-tool`, `provider`,
`persistence`, `render`, `runtime`, `uncaught`, or a later string). `severity` is
`warn`, `error`, or `fatal`. `context` is small structured metadata only: ids,
counts, status codes, operation names, timestamps, and other allow-listed scalar
fields. Thread/document content, prompts, credentials, free-form text, and
raw payloads are not valid diagnostic context.

Foreground agent errors complete the active Turn and remain visible in Thread
history. The same boundary also reports a diagnostic record. Unclassified
foreground failures use the `runtime` domain; callers pass a narrower domain
such as `command`, `provider`, `memory`, or `persistence` when known. Background
extension reconciliation and storage failures report through the same path.

## Safety Nets

Main installs process-level handlers:

- `uncaughtException` records a fatal `uncaught` diagnostic and exits after a
  short bounded flush.
- `unhandledRejection` records a fatal `uncaught` diagnostic and lets the app keep
  running.

Preload installs handlers for `window.error` and `window.unhandledrejection` as
the early, isolated-world safety net. The renderer entry installs the same
handlers in the main world and reports through the preload bridge. Both paths
send structured reports to main over `lin:report-renderer-error`; the renderer
never writes files directly. Duplicate reports collapse by fingerprint. The
real-Electron smoke suite verifies that renderer error and rejection events reach
the local diagnostics file under `contextIsolation: true` and `sandbox: true`.

## Local Log

Diagnostics are stored under the app `userData` directory:

```txt
<userData>/diagnostics/errors.jsonl
```

The file uses the shared `AppendOnlySeqLog` primitive. Each persisted line is an
aggregate record:

```ts
{
  v: 1,
  seq,
  eventId,
  ts,
  firstAt,
  lastAt,
  count,
  domain,
  severity,
  code?,
  fingerprint,
  message,
  context?
}
```

The write boundary normalizes and scrubs every report before it is persisted:

- `message` and context strings are length-capped.
- `context` keeps only an allow-list of structured keys.
- `source` context is reduced to a non-identifying label: `file://local` for
  local app files, URL origin for `http(s)`, or a path basename.
- raw stack traces are not stored; stack text contributes only a `stackHash`.
- the fingerprint is computed from domain, severity, code, normalized message,
  error name, and stack hash so floods collapse into one `count`ed record.

The log is compacted after writes so the revealed file contains at most one
record per fingerprint, capped to the most recent 200 fingerprints. This keeps a
repeating background failure readable and bounded.

## Settings Surface

Settings -> General -> Diagnostics exposes the only user-facing diagnostics
surface:

- **Reveal diagnostics log** opens `errors.jsonl` in Finder through
  `shell.showItemInFolder`.
- **Export diagnostics...** opens a save dialog and writes a JSON artifact with
  the current aggregate records plus minimal environment metadata: app version,
  platform, architecture, Electron/Chrome/Node versions, and active provider id.

There is no dashboard and no accumulation hint. The user exports or reveals the
artifact only when asked to send it for debugging.
