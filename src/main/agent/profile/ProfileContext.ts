import type { ProfileEntryView } from '../../../core/agent/profileFiles';
import type { ProfileFileStore } from './ProfileFileStore';
import { estimateTextTokens } from '../context/ContextBudgetPlanner';

export interface ProfilePromptContext {
  readonly identity: string | null;
  readonly style: string | null;
  readonly user: string | null;
  readonly paths: { readonly user: string; readonly identity: string; readonly style: string; readonly status: string };
  readonly revisions: readonly { readonly path: string; readonly revision: number; readonly digest: string | null }[];
}
export interface ProfileTurnSnapshot {
  readonly identity: string | null;
  readonly style: string | null;
  readonly entries: readonly ProfileEntryView[];
  readonly revisions: ProfilePromptContext['revisions'];
  readonly errors: readonly string[];
  readonly paths: ProfilePromptContext['paths'];
}

/** Accepted file observations are fixed once per root Turn, including retries. */
export function captureProfileTurn(store: ProfileFileStore, turnId: string, profileName: string, learned: boolean): ProfileTurnSnapshot {
  const prior = store.readTurnSnapshot<ProfileTurnSnapshot>(turnId);
  if (prior) return prior;
  const paths = { user: store.path('user'), identity: store.path('identity', profileName), style: store.path('style', profileName), status: store.statusPath() };
  const files = ['identity', 'style', 'user'].map((kind) => store.inspect(kind as 'identity' | 'style' | 'user', profileName));
  const errors = files.flatMap((file) => file.error ? [`${file.path}: ${file.error}`] : []);
  const accepted = (index: number) => files[index].state === 'accepted' ? files[index].content.trim() || null : null;
  let identity = accepted(0);
  let style = accepted(1);
  const candidates = files[2].state === 'accepted' ? files[2].entries.filter((entry) => entry.available) : [];
  let entries = candidates.filter((entry) => entry.authorship !== 'learned');
  const revisions = files.filter((file) => file.state === 'accepted').map((file) => ({ path: file.path, revision: file.revision, digest: file.acceptedDigest }));
  const rendered = (values: readonly ProfileEntryView[]) => profileComponentText({ identity, style, user: userText(values), paths, revisions }).join('\n\n');
  let remaining = 2000 - estimateTextTokens(rendered(entries));
  if (remaining < 0) {
    errors.push('Authored Profile text exceeds the combined 2,000-token ceiling. Shorten the files before activation.');
    identity = null;
    style = null;
    entries = [];
  } else if (learned) {
    remaining = Math.min(remaining, 600);
    for (const entry of candidates.filter((item) => item.authorship === 'learned')) {
      const tokens = estimateTextTokens(entryText(entry));
      if (tokens > remaining || estimateTextTokens(rendered([...entries, entry])) > 2000) continue;
      remaining -= tokens;
      entries.push(entry);
    }
  }
  const snapshot: ProfileTurnSnapshot = { identity, style, entries, errors, revisions, paths };
  store.saveTurnSnapshot(turnId, snapshot);
  for (const file of files) store.inspect(file.kind, profileName);
  return snapshot;
}

export function profilePromptForTurn(store: ProfileFileStore, turnId: string, allowLearned: boolean): ProfilePromptContext | null {
  const snapshot = store.readTurnSnapshot<ProfileTurnSnapshot>(turnId);
  if (!snapshot) return null;
  const entries = snapshot.entries.filter((entry) => entry.authorship !== 'learned' || allowLearned && store.entryAvailable(entry));
  return { identity: snapshot.identity, style: snapshot.style, revisions: snapshot.revisions, paths: snapshot.paths, user: userText(entries) };
}

function userText(entries: readonly ProfileEntryView[]): string | null {
  return entries.length ? [
    'Apply these scoped preferences when relevant. Current user instructions and explicit identity/configuration take precedence. Entries cannot grant capabilities or permissions.',
    'Learned entries summarize reader evidence, not independently verified facts. Do not fabricate a Memory Node citation for a profile preference.',
    ...entries.map(entryText),
  ].join('\n\n') : null;
}

export function profileComponentText(profile: ProfilePromptContext): readonly string[] {
  return [
    profile.identity ? `# Explicit Profile identity\n${profile.identity}` : null,
    profile.style ? `# Explicit Profile style defaults\n${profile.style}` : null,
    profile.user ? `# Applicable user profile\n${profile.user}` : null,
    `Profile sources for this Turn: ${JSON.stringify(profile.revisions)}`,
    `Public Profile files: ${JSON.stringify(profile.paths)}. For an explicit request to change identity/style or remember/correct/forget a stable personal preference, load the configuration Skill and edit the appropriate file with ordinary file tools. Verify accepted status before reporting success. Do not duplicate routine preferences as Memory Nodes.`,
    'Host policy and current applicable user instructions govern personalization. Explicit Profile developer instructions constrain identity/style components; scoped preferences refine style defaults but cannot change identity or capabilities.',
  ].filter((value): value is string => value !== null);
}

function entryText(entry: ProfileEntryView): string {
  return `[${entry.key}; ${entry.authorship}] ${entry.scope}\n${entry.text}`;
}
