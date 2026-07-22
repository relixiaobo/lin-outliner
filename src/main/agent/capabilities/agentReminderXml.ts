// `escapeXml` now lives in core (`src/core/reminderXml.ts`) so the POV flatten can
// share it; re-exported here so the main-process reminder builders keep their import.
export { escapeXml } from '../../../core/reminderXml';
import { escapeXml } from '../../../core/reminderXml';

// Serialize a leading ` key="value" ...` attribute string for the reminder blocks.
// Null / undefined / empty values are dropped; the rest are escaped verbatim — values
// where whitespace is significant (e.g. a file path) must not be collapsed here, so any
// free-text attribute that must stay single-line is compacted by its caller.
export function xmlAttrs(attrs: Record<string, string | null | undefined>): string {
  const serialized = Object.entries(attrs)
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${key}="${escapeXml(value)}"`);
  return serialized.length ? ` ${serialized.join(' ')}` : '';
}
