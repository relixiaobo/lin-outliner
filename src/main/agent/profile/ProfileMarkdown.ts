import { profileEntryKey, type UserProfileEntry } from '../../../core/agent/profileFiles';
import { containsSecretLikeContent } from '../capabilities/agentSecretRedaction';

export const MAX_PROFILE_FILE_BYTES = 32_768;

export function validateProfileText(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_PROFILE_FILE_BYTES || text.includes('\0')) throw new Error('Profile file exceeds its text limit');
  if (containsSecretLikeContent(text)) throw new Error('Profile files cannot contain secrets or credentials');
}

export function parseUserProfile(text: string): readonly UserProfileEntry[] {
  validateProfileText(text);
  if (!text.trim()) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const sections = normalized.split(/^## /m);
  if (sections.shift()!.trim() !== '# User') throw new Error('USER.md must start with # User and use ## entry-key sections');
  if (sections.length > 64) throw new Error('USER.md contains too many entries');
  const keys = new Set<string>();
  return sections.map((section) => {
    const [heading, ...lines] = section.split('\n');
    const key = profileEntryKey(heading.trim());
    if (keys.has(key)) throw new Error(`Duplicate Profile entry: ${key}`);
    keys.add(key);
    const body = lines.join('\n').trim();
    const match = /^Scope: ([^\n]+)\n([\s\S]+)$/.exec(body);
    if (!match || !match[2].trim() || match[1].length > 240 || match[2].trim().length > 1200) throw new Error(`Profile entry ${key} requires a bounded Scope and statement`);
    return { key, scope: match[1].trim(), text: match[2].trim() };
  });
}

export function renderUserProfile(entries: readonly UserProfileEntry[]): string {
  return '# User\n' + entries.map((entry) => `\n## ${entry.key}\nScope: ${entry.scope}\n${entry.text}\n`).join('');
}
