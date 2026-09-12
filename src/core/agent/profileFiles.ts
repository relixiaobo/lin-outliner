export type ProfileFileKind = 'identity' | 'style' | 'user';
export type ProfileAuthorship = 'manual' | 'agent' | 'learned';

export interface UserProfileEntry {
  readonly key: string;
  readonly scope: string;
  readonly text: string;
}

export interface ProfileEvidence {
  readonly threadId: string;
  readonly turnId: string;
  readonly originItemId: string;
  readonly sourceDate: string;
  readonly observedAt: number;
  readonly readerText: boolean;
}

export interface ProfileEntryView extends UserProfileEntry {
  readonly authorship: ProfileAuthorship;
  readonly updatedAt: number;
  readonly sources: readonly ProfileEvidence[];
  readonly available: boolean;
}

export interface ProfileFileView {
  readonly kind: ProfileFileKind;
  readonly profileName: string;
  readonly path: string;
  readonly content: string;
  readonly savedDigest: string | null;
  readonly acceptedDigest: string | null;
  readonly revision: number;
  readonly state: 'missing' | 'accepted' | 'pending' | 'rejected';
  readonly error: string | null;
  readonly entries: readonly ProfileEntryView[];
  readonly effective: { readonly turnId: string; readonly revision: number; readonly digest: string | null } | null;
  readonly activationError: string | null;
}

export interface ProfileLearningChange {
  readonly action: 'upsert' | 'forget';
  readonly key: string;
  readonly scope: string;
  readonly text: string;
  readonly originItemIds: readonly string[];
  readonly rationale: { readonly futureUse: string; readonly novelty: string };
}

export function decodeProfileLearningChanges(value: unknown): readonly ProfileLearningChange[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 24) throw new Error('Profile changes must be a bounded array');
  const keys = new Set<string>();
  return value.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Profile change');
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['action', 'key', 'scope', 'text', 'originItemIds', 'rationale'].includes(key))) throw new Error('Unknown Profile change field');
    if (record.action !== 'upsert' && record.action !== 'forget') throw new Error('Invalid Profile change action');
    const key = profileEntryKey(record.key);
    if (keys.has(key)) throw new Error('Duplicate Profile change key');
    keys.add(key);
    if (!Array.isArray(record.originItemIds) || record.originItemIds.length === 0 || record.originItemIds.length > 64) throw new Error('Profile changes require evidence IDs');
    const originItemIds = record.originItemIds.map((id) => profileText(id, 200));
    if (new Set(originItemIds).size !== originItemIds.length) throw new Error('Duplicate Profile evidence');
    const rationale = record.rationale as Record<string, unknown> | null;
    if (!rationale || typeof rationale !== 'object' || Object.keys(rationale).some((key) => !['futureUse', 'novelty'].includes(key))) throw new Error('Profile change requires a rationale');
    return { action: record.action, key, scope: profileText(record.scope, 240), text: profileText(record.text, 1200), originItemIds,
      rationale: { futureUse: profileText(rationale.futureUse, 600), novelty: profileText(rationale.novelty, 600) } };
  });
}

export function profileEntryKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error('Profile entry keys use lowercase letters, numbers and hyphens');
  return value;
}

function profileText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw new Error('Invalid or oversized Profile text');
  return value.trim();
}

export interface ProfileSourceView {
  readonly state: 'available' | 'unavailable';
  readonly source: ProfileEvidence;
  readonly content: string;
  readonly truncated: boolean;
}
