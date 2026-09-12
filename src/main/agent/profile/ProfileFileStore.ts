import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProfileAuthorship, ProfileEvidence, ProfileFileKind, ProfileFileView, ProfileEntryView, ProfileLearningChange, UserProfileEntry } from '../../../core/agent/profileFiles';
import { atomicWriteFileSync, writeJsonFileSync } from '../../jsonFileStore';
import { closeSqliteAfterFailure, openSqlite, type SqliteDatabase } from '../persistence/sqlite';
import { estimateTextTokens } from '../context/ContextBudgetPlanner';
import { parseUserProfile, renderUserProfile, validateProfileText } from './ProfileMarkdown';

interface EntryRecord extends UserProfileEntry {
  readonly authorship: ProfileAuthorship;
  readonly updatedAt: number;
  readonly sources: readonly ProfileEvidence[];
}
interface Tombstone { readonly key: string; readonly textHash: string; readonly originItemIds: readonly string[] }
interface DocumentRecord {
  readonly kind: ProfileFileKind;
  readonly profileName: string;
  readonly revision: number;
  readonly content: string | null;
  readonly entries: readonly EntryRecord[];
  readonly tombstones: readonly Tombstone[];
}
interface Publication {
  readonly requestDigest?: string;
  readonly id: string;
  readonly key: string;
  readonly before: DocumentRecord;
  readonly after: DocumentRecord;
  readonly automatic: boolean;
}
interface PublicationRow { id: string; state: string; payload: string; request_digest: string | null; updated_at: number }

export interface ProfileResetTarget {
  readonly revision: number;
  readonly digest: string | null;
  readonly keys: readonly string[];
}

export class ProfileConflictError extends Error {
  constructor(readonly state: 'stale' | 'pending' | 'conflicted' | 'cancelled', message: string) {
    super(message);
    this.name = 'ProfileConflictError';
  }
}

/** Owns file admission, accepted revisions and receipts; file text is canonical. */
export class ProfileFileStore {
  private readonly db: SqliteDatabase;
  private readonly hostSessionId = randomUUID();
  constructor(private readonly userData: string, database?: SqliteDatabase, private readonly now: () => number = Date.now) {
    const path = join(userData, 'agent', 'profile-control.sqlite');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.userData = realpathSync(userData);
    this.db = database ?? openSqlite(path);
    try { this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS profile_documents (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS profile_publications (id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, request_digest TEXT, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS profile_invalidations (id TEXT PRIMARY KEY, state TEXT NOT NULL, turn_ids TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS profile_turns (turn_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT;
    `); } catch (error) { closeSqliteAfterFailure(this.db, error); }
  }

  close(): void { this.db.close(); }

  path(kind: ProfileFileKind, profileName = 'default'): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)) throw new Error('Invalid Profile component name');
    return kind === 'user' ? join(this.userData, 'agent', 'user', 'USER.md')
      : join(this.userData, 'agent', 'profiles', profileName, kind === 'identity' ? 'IDENTITY.md' : 'STYLE.md');
  }

  identifyPath(path: string): { kind: ProfileFileKind; profileName: string } | null {
    path = resolvedFileTarget(path);
    if (resolve(path) === resolve(this.path('user'))) return { kind: 'user', profileName: 'default' };
    const root = resolve(this.userData, 'agent', 'profiles');
    const relative = resolve(path).slice(root.length + 1);
    if (!resolve(path).startsWith(`${root}/`)) return null;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(IDENTITY|STYLE)\.md$/.exec(relative);
    return match ? { kind: match[2] === 'IDENTITY' ? 'identity' : 'style', profileName: match[1] } : null;
  }

  inspect(kind: ProfileFileKind, profileName = 'default'): ProfileFileView {
    const path = this.path(kind, profileName);
    let content: string | null = null;
    let state: ProfileFileView['state'] = 'missing';
    let error: string | null = null;
    let record = this.read(kind, profileName);
    try {
      this.recover(documentKey(kind, profileName));
      if (kind === 'user' && this.committedInvalidTurnIds().size) this.reconcileInvalidations();
      record = this.observe(kind, profileName);
      content = readText(path);
      state = content === null ? 'missing' : 'accepted';
    } catch (caught) {
      error = errorText(caught);
      state = caught instanceof ProfileConflictError && caught.state === 'pending' ? 'pending' : 'rejected';
      try { content = readText(path); } catch { /* The error remains visible without invented contents. */ }
    }
    const effectiveRow = this.db.prepare(`SELECT turn_id, snapshot FROM profile_turns
      WHERE EXISTS (SELECT 1 FROM json_each(profile_turns.snapshot, '$.revisions') AS revision
        WHERE json_extract(revision.value, '$.path') = ?)
      ORDER BY rowid DESC LIMIT 1`).all(path) as { turn_id: string; snapshot: string }[];
    let effective: ProfileFileView['effective'] = null;
    let activationError: string | null = null;
    for (const row of effectiveRow) {
      const snapshot = JSON.parse(row.snapshot) as { revisions: { path: string; revision: number; digest: string | null }[]; errors: string[] };
      const revision = snapshot.revisions.find((entry) => entry.path === path);
      if (!revision) continue;
      activationError = snapshot.errors.join('\n') || null;
      if (!activationError) effective = { turnId: row.turn_id, revision: revision.revision, digest: revision.digest };
      break;
    }
    const view: ProfileFileView = { kind, profileName, path, content: content ?? '', savedDigest: digest(content),
      acceptedDigest: digest(record.content), revision: record.revision, state, error, effective, activationError,
      entries: record.entries.map((entry): ProfileEntryView => ({ ...entry, available: this.entryAvailable(entry) })),
    };
    this.writeStatus(view);
    return view;
  }

  /** Keep only snapshots whose canonical Turns can still be replayed. */
  pruneTurnSnapshots(retainedTurnIds: ReadonlySet<string>): void {
    this.transaction(() => {
      if (retainedTurnIds.size === 0) {
        this.db.exec('DELETE FROM profile_turns');
      } else {
        const placeholders = [...retainedTurnIds].map(() => '?').join(',');
        this.db.prepare(`DELETE FROM profile_turns WHERE turn_id NOT IN (${placeholders})`).run(...retainedTurnIds);
      }
      this.compactAcceptedPublications();
    });
  }

  /** Delete private state that belongs to a conversation removed from history. */
  deleteThreadState(threadId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM profile_turns WHERE json_extract(snapshot, '$.threadId') = ?").run(threadId);
      const rows = this.db.prepare("SELECT id, payload FROM profile_publications WHERE state = 'prepared'").all() as Array<{ id: string; payload: string }>;
      for (const row of rows) {
        const publication = JSON.parse(row.payload) as Publication;
        const sources = [...publication.before.entries, ...publication.after.entries].flatMap((entry) => entry.sources);
        if (sources.some((source) => source.threadId === threadId)) {
          this.db.prepare("UPDATE profile_publications SET state = 'cancelled', payload = ?, updated_at = ? WHERE id = ?")
            .run(JSON.stringify({ id: row.id, state: 'cancelled' }), this.now(), row.id);
        }
      }
      this.compactAcceptedPublications();
    });
  }

  /** Accepted files no longer need before/after bodies for recovery. */
  private compactAcceptedPublications(): void {
    const cutoff = this.now() - 90 * 24 * 60 * 60 * 1_000;
    this.db.prepare("DELETE FROM profile_publications WHERE state = 'accepted' AND updated_at < ?").run(cutoff);
    this.db.prepare(`
      DELETE FROM profile_publications
      WHERE state = 'accepted' AND id NOT IN (
        SELECT id FROM profile_publications WHERE state = 'accepted' ORDER BY updated_at DESC LIMIT 512
      )
    `).run();
  }

  statusPath(): string { return join(this.userData, 'agent', 'profile-status.json'); }

  private writeStatus(view: ProfileFileView): void {
    this.writeStatusViews([view]);
  }

  private writeStatusViews(views: readonly ProfileFileView[]): void {
    const path = this.statusPath();
    let files: Record<string, unknown> = {};
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8'));
      if (previous.hostSessionId === this.hostSessionId && previous.files && typeof previous.files === 'object') files = previous.files;
    } catch { /* First observation in this Host session. */ }
    for (const view of views) {
      const { content: _content, entries: _entries, ...status } = view;
      files[documentKey(view.kind, view.profileName)] = status;
    }
    writeJsonFileSync(path, { hostSessionId: this.hostSessionId, observedAt: this.now(), files }, { mode: 0o600, directoryMode: 0o700 });
  }

  /** Publish status from views already captured during Turn admission. */
  refreshTurnStatus(turnId: string, views: readonly ProfileFileView[]): void {
    const snapshot = this.readTurnSnapshot<{ revisions: readonly { path: string; revision: number; digest: string | null }[]; errors: readonly string[] }>(turnId);
    if (!snapshot) return;
    const refreshed = views.map((view) => {
      const revision = snapshot.revisions.find((entry) => entry.path === view.path);
      return {
        ...view,
        effective: revision && snapshot.errors.length === 0
          ? { turnId, revision: revision.revision, digest: revision.digest }
          : null,
        activationError: snapshot.errors.join('\n') || null,
      };
    });
    this.writeStatusViews(refreshed);
  }

  edit(input: { kind: ProfileFileKind; profileName?: string; expectedDigest: string | null; content: string; author: 'manual' | 'agent'; sources?: readonly ProfileEvidence[]; operationId?: string }): ProfileFileView {
    const profileName = input.profileName ?? 'default';
    const content = readText(this.path(input.kind, profileName));
    let before = this.read(input.kind, profileName);
    try { before = this.observe(input.kind, profileName); }
    catch (error) {
      if (error instanceof ProfileConflictError) throw error;
      before = { ...before, content };
    }
    if (digest(before.content) !== input.expectedDigest) throw new ProfileConflictError('stale', 'Profile file changed; refresh before retrying');
    this.validate(input.kind, input.content);
    const after = this.authoredRevision(before, input.content, input.author, input.sources ?? []);
    this.publish({ id: input.operationId ?? `profile:edit:${randomUUID()}`, key: documentKey(input.kind, profileName), before, after, automatic: false });
    return this.inspect(input.kind, profileName);
  }

  applyLearning(operationId: string, expectedRevision: number, changes: readonly ProfileLearningChange[], evidence: readonly ProfileEvidence[]): void {
    const requestDigest = digest(JSON.stringify({ expectedRevision, changes, evidence }))!;
    const pending = this.publication(operationId);
    if (pending?.state === 'accepted') {
      if (pending.request_digest !== requestDigest) throw new Error('Profile publication ID has different input');
      return;
    }
    if (pending && (pending.request_digest ?? (JSON.parse(pending.payload) as Publication).requestDigest) !== requestDigest) throw new Error('Profile publication ID has different input');
    if (pending?.state === 'prepared') { this.settle(JSON.parse(pending.payload) as Publication); return; }
    if (pending) throw new ProfileConflictError('cancelled', 'Profile publication cannot be replayed');
    const before = this.observe('user', 'default');
    if (before.revision !== expectedRevision) throw new ProfileConflictError('stale', 'User profile changed during learning');
    const entries = new Map(before.entries.map((entry) => [entry.key, entry]));
    const tombstones = [...before.tombstones];
    const byOrigin = new Map(evidence.map((source) => [source.originItemId, source]));
    for (const change of changes) {
      const sources = change.originItemIds.map((id) => {
        const source = byOrigin.get(id);
        if (!source || this.invalidTurnIds().has(source.turnId)) throw new Error('Profile learning cited unavailable or invalidated evidence');
        return source;
      });
      if (!sources.some((source) => source.readerText)) throw new Error('Profile learning requires reader-authored text');
      const current = entries.get(change.key);
      if (current && current.authorship !== 'learned') continue;
      if (change.action === 'forget') {
        if (current) tombstones.push(tombstone(current, sources));
        entries.delete(change.key);
        continue;
      }
      if (tombstones.some((item) => (item.key === change.key || item.textHash === digest(change.text))
        && sources.some((source) => item.originItemIds.includes(source.originItemId)))) continue;
      const unchanged = current?.scope === change.scope && current.text === change.text;
      entries.set(change.key, { key: change.key, scope: change.scope, text: change.text, authorship: 'learned',
        updatedAt: unchanged ? current.updatedAt : this.now(), sources: unchanged ? unionSources(current.sources, sources) : sources });
    }
    const next = [...entries.values()];
    const content = sameEntries(before.entries, next) ? before.content ?? renderUserProfile(next) : renderUserProfile(next);
    this.validate('user', content);
    const after = { ...before, revision: before.revision + 1, content, entries: next, tombstones };
    this.publish({ id: operationId, requestDigest, key: 'user', before, after, automatic: true });
  }

  receipt(id: string): boolean { return this.publication(id)?.state === 'accepted'; }

  cancelLearning(id: string): void {
    const row = this.publication(id);
    if (row?.state !== 'prepared') return;
    const publication = JSON.parse(row.payload) as Publication;
    if (readText(this.path(publication.after.kind, publication.after.profileName)) === publication.after.content) {
      this.settle(publication);
      return;
    }
    this.db.prepare("UPDATE profile_publications SET state = 'cancelled' WHERE id = ? AND state = 'prepared'").run(id);
  }

  private publication(id: string): PublicationRow | null {
    return this.db.prepare('SELECT id, state, payload, request_digest, updated_at FROM profile_publications WHERE id = ?').get(id) as PublicationRow | null;
  }

  prepareInvalidation(id: string, turnIds: readonly string[]): void {
    this.db.prepare("INSERT INTO profile_invalidations(id, state, turn_ids) VALUES (?, 'prepared', ?) ON CONFLICT(id) DO NOTHING").run(id, JSON.stringify(turnIds));
  }
  abortInvalidation(id: string): void {
    this.db.prepare("DELETE FROM profile_invalidations WHERE id = ? AND state = 'prepared'").run(id);
  }
  commitInvalidation(id: string, turnIds: readonly string[]): void {
    this.prepareInvalidation(id, turnIds);
    this.db.prepare("UPDATE profile_invalidations SET state = 'committed' WHERE id = ?").run(id);
    // Suppression is durable before optional file maintenance. A failed disk
    // rewrite must not block history rollback or reactivate invalid content.
    try { this.reconcileInvalidations(); } catch { /* Inspection/recovery retries the file revision. */ }
  }

  resetTarget(): ProfileResetTarget {
    const record = this.observe('user', 'default');
    return { revision: record.revision, digest: digest(record.content), keys: record.entries.filter((entry) => entry.authorship === 'learned').map((entry) => entry.key) };
  }

  reset(operationId: string, target: ProfileResetTarget): void {
    if (this.receipt(operationId)) return;
    const before = this.observe('user', 'default');
    if (before.revision !== target.revision || digest(before.content) !== target.digest) throw new ProfileConflictError('stale', 'User profile changed after Reset review');
    const removed = before.entries.filter((entry) => target.keys.includes(entry.key) && entry.authorship === 'learned');
    if (removed.length !== target.keys.length) throw new ProfileConflictError('stale', 'User profile Reset target changed');
    const entries = before.entries.filter((entry) => !target.keys.includes(entry.key));
    this.db.prepare("UPDATE profile_publications SET state = 'cancelled' WHERE state = 'prepared' AND json_extract(payload, '$.automatic') = 1").run();
    this.publish({ id: operationId, key: 'user', before, after: { ...before, revision: before.revision + 1,
      content: renderUserProfile(entries), entries, tombstones: [...before.tombstones, ...removed.map((entry) => tombstone(entry))] }, automatic: false });
  }

  recover(key?: string): void {
    for (const row of this.db.prepare("SELECT id, state, payload FROM profile_publications WHERE state = 'prepared' ORDER BY rowid").all() as PublicationRow[]) {
      const publication = JSON.parse(row.payload) as Publication;
      // Learned writes resume only through the batch owner after fresh source,
      // mode and reset admission. Inspection cannot authorize pending learning.
      if (!publication.automatic && (key === undefined || publication.key === key)) this.settle(publication);
    }
  }

  readTurnSnapshot<T>(turnId: string): T | null {
    const row = this.db.prepare('SELECT snapshot FROM profile_turns WHERE turn_id = ?').get(turnId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as T : null;
  }
  saveTurnSnapshot(turnId: string, snapshot: unknown): void {
    this.db.prepare('INSERT INTO profile_turns(turn_id, snapshot) VALUES (?, ?) ON CONFLICT(turn_id) DO NOTHING').run(turnId, JSON.stringify(snapshot));
  }

  entryAvailable(entry: EntryRecord): boolean {
    if (entry.authorship !== 'learned') return true;
    const invalid = this.invalidTurnIds();
    const tombstones = this.read('user', 'default').tombstones;
    if (tombstones.some((item) => (item.key === entry.key || item.textHash === digest(entry.text))
      && entry.sources.some((source) => item.originItemIds.includes(source.originItemId)))) return false;
    return entry.sources.some((source) => source.readerText && !invalid.has(source.turnId));
  }

  reconcileInvalidations(): void {
    const committed = this.committedInvalidTurnIds();
    const unsupported = (entry: EntryRecord) => entry.authorship === 'learned'
      && !entry.sources.some((source) => source.readerText && !committed.has(source.turnId));
    const before = this.observe('user', 'default');
    const removed = before.entries.filter(unsupported);
    if (!removed.length) return;
    const entries = before.entries.filter((entry) => !unsupported(entry));
    this.publish({ id: `profile:invalidate:${randomUUID()}`, key: 'user', before, after: { ...before,
      revision: before.revision + 1, content: renderUserProfile(entries), entries,
      tombstones: [...before.tombstones, ...removed.map((entry) => tombstone(entry))] }, automatic: false });
  }

  private committedInvalidTurnIds(): ReadonlySet<string> {
    return new Set((this.db.prepare("SELECT turn_ids FROM profile_invalidations WHERE state = 'committed'").all() as { turn_ids: string }[])
      .flatMap((row) => JSON.parse(row.turn_ids) as string[]));
  }

  private invalidTurnIds(): ReadonlySet<string> {
    return new Set((this.db.prepare("SELECT turn_ids FROM profile_invalidations WHERE state IN ('prepared', 'committed')").all() as { turn_ids: string }[])
      .flatMap((row) => JSON.parse(row.turn_ids) as string[]));
  }

  private read(kind: ProfileFileKind, profileName: string): DocumentRecord {
    const row = this.db.prepare('SELECT value FROM profile_documents WHERE key = ?').get(documentKey(kind, profileName)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as DocumentRecord : { kind, profileName, revision: 0, content: null, entries: [], tombstones: [] };
  }

  private observe(kind: ProfileFileKind, profileName: string): DocumentRecord {
    const before = this.read(kind, profileName);
    const pending = this.db.prepare("SELECT id FROM profile_publications WHERE state = 'prepared' AND json_extract(payload, '$.key') = ?").get(documentKey(kind, profileName));
    if (pending) throw new ProfileConflictError('pending', 'Profile publication is pending recovery');
    const content = readText(this.path(kind, profileName));
    if (content === before.content) return before;
    this.validate(kind, content ?? '');
    const after = this.authoredRevision(before, content, 'manual', []);
    this.db.prepare('INSERT INTO profile_documents(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(documentKey(kind, profileName), JSON.stringify(after));
    return after;
  }

  private authoredRevision(before: DocumentRecord, content: string | null, author: ProfileAuthorship, sources: readonly ProfileEvidence[]): DocumentRecord {
    const previous = new Map(before.entries.map((entry) => [entry.key, entry]));
    const entries = before.kind === 'user' ? parseUserProfile(content ?? '').map((entry): EntryRecord => {
      const old = previous.get(entry.key);
      return old && old.scope === entry.scope && old.text === entry.text ? old : { ...entry, authorship: author, sources, updatedAt: this.now() };
    }) : [];
    const removed = before.entries.filter((entry) => !entries.some((next) => next.key === entry.key));
    return { ...before, revision: before.revision + 1, content, entries,
      tombstones: [...before.tombstones, ...removed.map((entry) => tombstone(entry))] };
  }

  private validate(kind: ProfileFileKind, content: string): void {
    validateProfileText(content);
    if (kind === 'user') parseUserProfile(content);
    else if (estimateTextTokens(content) > 2000) throw new Error('Profile component exceeds the 2,000-token activation ceiling');
  }

  private publish(publication: Publication): void {
    const requestDigest = publication.requestDigest ?? digest(JSON.stringify({
      key: publication.key, beforeRevision: publication.before.revision, afterRevision: publication.after.revision,
      afterContent: publication.after.content,
    }))!;
    publication = { ...publication, requestDigest };
    const existing = this.db.prepare('SELECT id, state, payload, request_digest, updated_at FROM profile_publications WHERE id = ?').get(publication.id) as PublicationRow | undefined;
    if (existing) {
      if (existing.state === 'accepted') return;
      if ((existing.request_digest ?? (JSON.parse(existing.payload) as Publication).requestDigest) !== requestDigest) throw new Error('Profile publication ID has different content');
      if (existing.state !== 'prepared') throw new ProfileConflictError('cancelled', 'Profile publication cannot be replayed');
    } else {
      this.db.prepare("INSERT INTO profile_publications(id, state, payload, request_digest, updated_at) VALUES (?, 'prepared', ?, ?, ?)").run(publication.id, JSON.stringify(publication), requestDigest, this.now());
    }
    this.settle(publication);
  }

  private settle(publication: Publication): void {
    const { after, before } = publication;
    const requestDigest = publication.requestDigest ?? digest(JSON.stringify({
      key: publication.key, beforeRevision: before.revision, afterRevision: after.revision,
      afterContent: after.content,
    }))!;
    const path = this.path(after.kind, after.profileName);
    const current = readText(path);
    if (current !== before.content && current !== after.content) {
      this.db.prepare("UPDATE profile_publications SET state = 'conflicted' WHERE id = ?").run(publication.id);
      throw new ProfileConflictError('conflicted', 'Profile file changed during publication; external content was preserved');
    }
    const accepted = this.read(after.kind, after.profileName);
    if (accepted.revision !== before.revision && accepted.revision !== after.revision) throw new ProfileConflictError('stale', 'Profile accepted revision changed during publication');
    if (publication.automatic && current !== after.content && after.entries.some((entry) => entry.authorship === 'learned'
      && !entry.sources.some((source) => source.readerText && !this.invalidTurnIds().has(source.turnId)))) {
      this.cancelLearning(publication.id);
      throw new Error('Profile learning sources were invalidated before publication');
    }
    if (current !== after.content) atomicWriteFileSync(path, after.content ?? '', { mode: 0o600, directoryMode: 0o700 });
    this.transaction(() => {
      this.db.prepare('INSERT INTO profile_documents(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(publication.key, JSON.stringify(after));
      this.db.prepare("UPDATE profile_publications SET state = 'accepted', payload = ?, request_digest = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ id: publication.id, key: publication.key, requestDigest, afterRevision: after.revision, afterDigest: digest(after.content) }), requestDigest, this.now(), publication.id);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function documentKey(kind: ProfileFileKind, profileName: string): string { return kind === 'user' ? 'user' : `${kind}:${profileName}`; }
export function profileFileDigest(text: string | null): string | null { return digest(text); }
function digest(text: string | null): string | null { return text === null ? null : createHash('sha256').update(text).digest('hex'); }
function readText(path: string): string | null {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Managed Profile files must be regular files');
    return readFileSync(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function unionSources(a: readonly ProfileEvidence[], b: readonly ProfileEvidence[]): readonly ProfileEvidence[] {
  return [...new Map([...a, ...b].map((source) => [source.originItemId, source])).values()];
}
function tombstone(entry: EntryRecord, extra: readonly ProfileEvidence[] = []): Tombstone {
  return { key: entry.key, textHash: digest(entry.text)!, originItemIds: unionSources(entry.sources, extra).map((source) => source.originItemId) };
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 512); }

function sameEntries(a: readonly UserProfileEntry[], b: readonly UserProfileEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.key === b[index].key && entry.scope === b[index].scope && entry.text === b[index].text);
}

export function decodeProfileResetTarget(value: unknown): ProfileResetTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Profile Reset target');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['revision', 'digest', 'keys'].includes(key)) || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0
    || input.digest !== null && (typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest))
    || !Array.isArray(input.keys) || input.keys.length > 64 || input.keys.some((key) => typeof key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(key))
    || new Set(input.keys).size !== input.keys.length) throw new Error('Invalid Profile Reset target');
  return { revision: input.revision as number, digest: input.digest as string | null, keys: input.keys as string[] };
}

function resolvedFileTarget(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { return join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1)); }
    catch { return resolve(path); }
  }
}
