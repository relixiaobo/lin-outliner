import type { StartupIssue, StartupIssueCategory } from '../core/startup';
import { scanSecretStrings } from './agent/capabilities/agentSecretStringScanner';

/** Owner observations, never message matching, determine the available recovery actions. */
export function startupIssue(operation: string, failure: unknown, source?: StartupIssue['source']): StartupIssue {
  let observed = failure;
  const seen = new Set<unknown>();
  while (observed instanceof Error && observed.cause !== undefined && !seen.has(observed)) {
    seen.add(observed);
    observed = observed.cause;
  }
  const record = observed !== null && typeof observed === 'object' ? observed as Record<string, unknown> : {};
  // Node SQLite exposes primary result codes as errcode under ERR_SQLITE_ERROR.
  const sqlite = record.code === 'ERR_SQLITE_ERROR' && typeof record.errcode === 'number'
    ? record.errcode & 0xff : null;
  const code = ({ 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 11: 'SQLITE_CORRUPT', 13: 'SQLITE_FULL', 26: 'SQLITE_NOTADB' } as Record<number, string>)[sqlite ?? -1] ?? record.code;
  const category: StartupIssueCategory = code === 'EACCES' || code === 'EPERM' ? 'permission'
    : code === 'ENOSPC' || code === 'SQLITE_FULL' ? 'storage-full'
      : code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'locked'
        : code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'STARTUP_INVALID_DATA' || observed instanceof SyntaxError ? 'invalid-data'
          : code === 'STARTUP_VERSION_MISMATCH' ? 'version-mismatch' : 'unknown';
  const domain = operation === 'agent' ? 'agent'
    : operation === 'outline-documents' || operation === 'personal-ranking' ? 'outline'
      : operation === 'provider-configuration' || operation === 'configuration-observation' ? 'configuration' : 'desktop';
  const message = scrub(observed instanceof Error ? observed.message : String(observed), 1_000);
  const details = scrub([
    `Capability: ${domain}`, `Operation: ${operation}`, `Category: ${category}`,
    observed instanceof Error ? observed.stack ?? observed.message : String(observed),
    failure !== observed && failure instanceof Error ? failure.message : '',
  ].join('\n'), 8_000);
  return {
    id: operation, domain, operation, category, message, details,
    actions: source ? ['copy-details', 'open-source'] : ['copy-details'],
    ...(source ? { source } : {}),
    ...(category === 'version-mismatch' && typeof record.found === 'number' && typeof record.expected === 'number'
      ? { format: { found: record.found, expected: record.expected } } : {}),
  };
}

function scrub(value: string, limit: number): string {
  // Oversized diagnostic text may split a secret; omit it instead of scanning a raw prefix.
  if (value.length > 32_000) return 'Startup details exceeded the display limit.';
  try {
    return scanSecretStrings([{ content: value, inspectEncodedJson: false, redactIncompletePrivateKeys: true }])[0]!.slice(0, limit);
  } catch {
    return 'Startup details could not be safely displayed.';
  }
}
