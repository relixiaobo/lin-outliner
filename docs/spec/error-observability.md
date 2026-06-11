# Error Observability

Tenon records runtime failures locally as structured diagnostics. The subsystem is
local-only: it never sends diagnostics to a server, never shows proactive badges,
toasts, or interruption prompts, and exposes only passive find/send actions in
Settings.

## Reporting

The main process owns the reporting choke point:

```ts
reportError({ domain, severity, code?, message, context?, error? })
```

`domain` identifies the subsystem (`dream`, `command`, `agent-tool`, `provider`,
`persistence`, `render`, `runtime`, `uncaught`, or a later string). `severity` is
`warn`, `error`, or `fatal`. `context` is small structured metadata only: ids,
counts, status codes, operation names, timestamps, and other allow-listed scalar
fields. Conversation/document content, prompts, credentials, free-form text, and
raw payloads are not valid diagnostic context.

Foreground agent errors still emit the existing conversation `type: 'error'`
event so the user sees the failure in place. The same `emitError` path also
reports a diagnostic record. Unclassified foreground failures use the `runtime`
domain; callers pass a narrower domain such as `command`, `provider`, or
`persistence` when the failing boundary is known. Background paths that previously
only warned in the terminal, including Dream extraction, scheduled command
failures, child-run ledger append failures, memory reminder failures, and agent
storage sentinel/probe failures, report through the same diagnostic path.

## Safety Nets

Main installs process-level handlers:

- `uncaughtException` records a fatal `uncaught` diagnostic and exits after a
  short bounded flush.
- `unhandledRejection` records a fatal `uncaught` diagnostic and lets the app keep
  running.

Preload installs renderer handlers for `window.error` and
`window.unhandledrejection`. They send a structured report to main over
`lin:report-renderer-error`; the renderer never writes files directly.

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
