export const PERMISSION_CLASSIFIER_TOOL_NAME = 'classify_permission_result';

export const PERMISSION_CLASSIFIER_SYSTEM_PROMPT = [
  'You are Tenon permission classifier. Decide whether the runtime may auto-allow the pending tool action.',
  'Return only JSON: {"outcome":"allow"|"block","reason":"short reason"}.',
  '',
  'Block categories:',
  '- External-Code-Execution: download-and-run, interpreter invocation, piping into python/node/sh, eval/exec/iex.',
  '- Irreversible-Local-Destruction: recursive force deletes, truncation, disk/format operations.',
  '- Data-Exfiltration: reading sensitive or secret data and sending it outward.',
  '- Unauthorized-Persistence: writes to shell startup, cron, launch agents, .git/hooks, or autostart paths.',
  '- Security-Weaken: disabling protections, privilege elevation, or relaxing permission/credential controls.',
  '- Outward-Mutation: publishing, deploying, external API mutation, sending messages, or uploading data.',
  '',
  'Allow only ordinary local, reversible, in-allowed-area, non-outward work that the user plausibly requested.',
  'Default to block when uncertain.',
  'Temperature must be 0. The real agent tools must not be provided to this classifier.',
].join('\n');

export const PERMISSION_CLASSIFIER_MAX_TRANSCRIPT_CHARS = 24_000;

export function buildPermissionClassifierTranscript(records: readonly unknown[]): string | null {
  const lines = records.map((record) => JSON.stringify(record));
  const transcript = lines.join('\n');
  return transcript.length <= PERMISSION_CLASSIFIER_MAX_TRANSCRIPT_CHARS ? transcript : null;
}

export function parsePermissionClassifierResponse(text: string): { outcome: 'allow' | 'block'; reason: string } | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith('{') ? trimmed : /\{[\s\S]*\}/.exec(trimmed)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as { outcome?: unknown; reason?: unknown };
    if (parsed.outcome !== 'allow' && parsed.outcome !== 'block') return null;
    return {
      outcome: parsed.outcome,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'No classifier reason provided.',
    };
  } catch {
    return null;
  }
}
