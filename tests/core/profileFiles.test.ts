import { estimateTextTokens } from '../../src/main/agent/context/ContextBudgetPlanner';
import { createAgentLocalWorkspaceContext, createLocalTools } from '../../src/main/agent/capabilities/agentLocalTools';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import type { ProfileEvidence, ProfileLearningChange } from '../../src/core/agent/profileFiles';
import { ProfileFileStore, profileFileDigest } from '../../src/main/agent/profile/ProfileFileStore';
import { captureProfileTurn, profilePromptForTurn, profileComponentText } from '../../src/main/agent/profile/ProfileContext';
import { parseUserProfile, renderUserProfile } from '../../src/main/agent/profile/ProfileMarkdown';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tenon-profile-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(':memory:');
  const store = new ProfileFileStore(root, db as unknown as SqliteDatabase, () => 123);
  cleanups.push(() => store.close());
  return { root, db, store };
}
const source = (id: string): ProfileEvidence => ({ threadId: `thread:${id}`, turnId: `turn:${id}`, originItemId: `item:${id}`, sourceDate: '2026-09-12', observedAt: 123, readerText: true });
const proposal = (id = 'a', text = 'Lead research reports with the conclusion.'): ProfileLearningChange => ({ action: 'upsert', key: 'reports', scope: 'Research reports', text, originItemIds: [`item:${id}`], rationale: { futureUse: 'Future research', novelty: 'Explicit ongoing request' } });

describe('Profile files', () => {
  test('learns directly, confirms without rewriting text, and protects an authored correction', () => {
    const { store } = fixture();
    store.applyLearning('learn:a', 0, [proposal()], [source('a')]);
    const first = store.inspect('user');
    expect(first.entries[0].authorship).toBe('learned');
    expect(parseUserProfile(first.content)[0].key).toBe('reports');
    store.applyLearning('learn:b', first.revision, [proposal('b')], [source('b')]);
    const confirmed = store.inspect('user');
    expect(confirmed.content).toBe(first.content);
    expect(confirmed.entries[0].sources.map((item) => item.originItemId)).toEqual(['item:a', 'item:b']);
    const authored = store.edit({ kind: 'user', expectedDigest: confirmed.savedDigest, content: confirmed.content.replace('with the conclusion.', 'with a short outline.'), author: 'manual' });
    store.applyLearning('learn:c', authored.revision, [proposal('c')], [source('c')]);
    expect(store.inspect('user').entries[0]).toMatchObject({ authorship: 'manual', text: 'Lead research reports with a short outline.' });
  });

  test('distinguishes independent support, rollback and source availability', () => {
    const { store } = fixture();
    store.applyLearning('learn:a', 0, [proposal()], [source('a')]);
    store.applyLearning('learn:b', store.inspect('user').revision, [proposal('b')], [source('b')]);
    store.prepareInvalidation('rollback:a', ['turn:a']);
    expect(store.inspect('user').entries[0].available).toBe(true);
    store.commitInvalidation('rollback:a', ['turn:a']);
    expect(store.inspect('user').entries).toHaveLength(1);
    store.prepareInvalidation('rollback:b', ['turn:b']);
    expect(store.inspect('user').entries[0].available).toBe(false);
    store.abortInvalidation('rollback:b');
    expect(store.inspect('user').entries[0].available).toBe(true);
    store.commitInvalidation('rollback:b', ['turn:b']);
    expect(store.inspect('user').entries).toHaveLength(0);
  });

  test('retains a deletion tombstone so delayed known evidence cannot restore the entry', () => {
    const { store } = fixture();
    store.applyLearning('learn:a', 0, [proposal()], [source('a')]);
    store.edit({ kind: 'user', expectedDigest: store.inspect('user').savedDigest, content: '# User\n', author: 'manual' });
    store.applyLearning('learn:stale', store.inspect('user').revision, [proposal()], [source('a')]);
    expect(store.inspect('user').entries).toHaveLength(0);
    store.applyLearning('learn:fresh', store.inspect('user').revision, [proposal('b')], [source('b')]);
    expect(store.inspect('user').entries).toHaveLength(1);
  });

  test('preserves concurrent edits and permits explicit repair of rejected Markdown', () => {
    const { store } = fixture();
    const first = store.edit({ kind: 'user', expectedDigest: null, content: '# User\n', author: 'manual' });
    writeFileSync(first.path, '# broken\n');
    const broken = store.inspect('user');
    expect(broken.state).toBe('rejected');
    expect(() => store.edit({ kind: 'user', expectedDigest: first.savedDigest, content: '# User\n', author: 'manual' })).toThrow('changed');
    expect(store.edit({ kind: 'user', expectedDigest: broken.savedDigest, content: '# User\n', author: 'manual' }).state).toBe('accepted');
  });

  test('reset is revision-guarded, idempotent and preserves authored entries', () => {
    const { store } = fixture();
    store.applyLearning('learn:a', 0, [proposal()], [source('a')]);
    const target = store.resetTarget();
    const first = store.inspect('user');
    const authored = store.edit({ kind: 'user', expectedDigest: first.savedDigest, content: first.content + '\n## language\nScope: General\nUse Chinese.\n', author: 'manual' });
    expect(() => store.reset('reset:old', target)).toThrow('changed');
    const next = store.resetTarget();
    store.reset('reset:new', next);
    store.reset('reset:new', next);
    expect(store.inspect('user').entries.map((entry) => entry.key)).toEqual(['language']);
    expect(authored.entries[0].authorship).toBe('learned');
  });

  test('captures one revision per Turn, applies the next edit later, and omits disabled learned context', () => {
    const { store } = fixture();
    store.applyLearning('learn:a', 0, [proposal()], [source('a')]);
    captureProfileTurn(store, 'turn:one', 'default', true);
    store.applyLearning('learn:b', store.inspect('user').revision, [proposal('b', 'Use a short outline for reports.')], [source('b')]);
    captureProfileTurn(store, 'turn:one', 'default', true);
    expect(profilePromptForTurn(store, 'turn:one', true)?.user).toContain('with the conclusion');
    captureProfileTurn(store, 'turn:two', 'default', true);
    expect(profilePromptForTurn(store, 'turn:two', true)?.user).toContain('short outline');
    captureProfileTurn(store, 'turn:off', 'default', false);
    expect(profilePromptForTurn(store, 'turn:off', false)?.user).toBeNull();
  });

  test('rejects malformed keys, credentials and component overflow without accepting bytes', () => {
    const { store } = fixture();
    expect(() => parseUserProfile('# User\n\n## same\nScope: General\nA\n\n## same\nScope: General\nB')).toThrow('Duplicate');
    expect(() => store.edit({ kind: 'identity', expectedDigest: null, content: 'x'.repeat(10000), author: 'manual' })).toThrow('ceiling');
    expect(store.inspect('identity').state).toBe('missing');
    expect(renderUserProfile([])).toBe('# User\n');
  });  test('uses the same publication owner through ordinary file tools, including an alias', async () => {
    const { store, root } = fixture();
    const workspace = createAgentLocalWorkspaceContext(root, join(root, 'scratch'));
    workspace.writeManagedFile = async (input) => {
      const target = store.identifyPath(input.path);
      if (!target) return false;
      store.edit({ ...target, content: input.content, expectedDigest: profileFileDigest(input.previousContent),
        author: 'agent', sources: [source('foreground')], operationId: input.operationId });
      return true;
    };
    const tools = createLocalTools({ workspace });
    const write = tools.find((tool) => tool.name === 'file_write')!;
    const content = renderUserProfile([{ key: 'language', scope: 'General', text: 'Use Chinese.' }]);
    const result = await write.execute('profile:tool:write', { file_path: store.path('user'), content });
    expect(result.isError).not.toBe(true);
    expect(store.inspect('user').entries[0].authorship).toBe('agent');
    const alias = join(root, 'alias.md');
    symlinkSync(store.path('user'), alias);
    expect(store.identifyPath(alias)?.kind).toBe('user');
    const read = tools.find((tool) => tool.name === 'file_read')!;
    await read.execute('profile:tool:read', { file_path: alias });
    const edited = await tools.find((tool) => tool.name === 'file_edit')!.execute('profile:tool:edit', {
      file_path: alias, old_string: 'Use Chinese.', new_string: 'Use Chinese for reports.',
    });
    expect(edited.isError).not.toBe(true);
    expect(store.inspect('user').entries[0].text).toBe('Use Chinese for reports.');
  });

  test('a saved file with interrupted metadata settlement recovers without becoming a manual edit', () => {
    const { store, db } = fixture();
    store.applyLearning('learn:a', 0, [proposal()], [source('a')]);
    const original = db.prepare.bind(db);
    let fail = true;
    db.prepare = ((sql: string) => {
      if (fail && sql.startsWith('INSERT INTO profile_documents')) {
        fail = false;
        throw new Error('Simulated metadata write failure');
      }
      return original(sql);
    }) as typeof db.prepare;
    const revision = store.inspect('user').revision;
    expect(() => store.applyLearning('learn:b', revision, [proposal('b', 'Use a short report.')], [source('b')])).toThrow('metadata');
    expect(readFileSync(store.path('user'), 'utf8')).toContain('short report');
    expect(store.inspect('user').state).toBe('pending');
    store.applyLearning('learn:b', revision, [proposal('b', 'Use a short report.')], [source('b')]);
    expect(store.inspect('user').entries[0]).toMatchObject({ authorship: 'learned', text: 'Use a short report.' });
    expect(store.receipt('learn:b')).toBe(true);
  });

  test('reports combined authored overflow and retains complete learned entries within the context budget', () => {
    const { store } = fixture();
    store.edit({ kind: 'identity', expectedDigest: null, content: 'Role. '.repeat(600), author: 'manual' });
    store.edit({ kind: 'style', expectedDigest: null, content: 'Style. '.repeat(600), author: 'manual' });
    const over = captureProfileTurn(store, 'turn:over', 'default', true);
    expect(over.errors.join()).toContain('combined');
    expect(over.identity).toBeNull();
    expect(store.inspect('identity').activationError).toContain('combined');
    store.edit({ kind: 'identity', expectedDigest: store.inspect('identity').savedDigest, content: 'Research assistant.', author: 'manual' });
    store.edit({ kind: 'style', expectedDigest: store.inspect('style').savedDigest, content: 'Be direct.', author: 'manual' });
    const changes = Array.from({ length: 12 }, (_, index) => ({ ...proposal(String(index), `Preference ${index}. `.repeat(20)), key: `preference-${index}` }));
    store.applyLearning('learn:many', 0, changes, changes.map((_, index) => source(String(index))));
    const admitted = captureProfileTurn(store, 'turn:bounded', 'default', true);
    expect(admitted.entries.length).toBeGreaterThan(0);
    expect(admitted.entries.length).toBeLessThan(12);
    const prompt = profilePromptForTurn(store, 'turn:bounded', true)!;
    expect(estimateTextTokens(profileComponentText(prompt).join('\n\n'))).toBeLessThanOrEqual(2000);
  });


  test('committing one rollback does not delete evidence under another prepared rollback', () => {
    const { store } = fixture();
    store.applyLearning('learn:two', 0, [proposal('a'), { ...proposal('b'), key: 'other' }], [source('a'), source('b')]);
    store.prepareInvalidation('rollback:b', ['turn:b']);
    store.commitInvalidation('rollback:a', ['turn:a']);
    expect(store.inspect('user').entries.map((entry) => entry.key)).toEqual(['other']);
    store.abortInvalidation('rollback:b');
    expect(store.inspect('user').entries[0].available).toBe(true);
  });

  test('publication identity cannot accept different learned input after settlement', () => {
    const { store } = fixture();
    store.applyLearning('learn:identity', 0, [proposal()], [source('a')]);
    store.applyLearning('learn:identity', 0, [proposal()], [source('a')]);
    expect(() => store.applyLearning('learn:identity', 0, [proposal('b')], [source('b')])).toThrow('different input');
  });

  test('reopens accepted files, source metadata and the fixed Turn snapshot after restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenon-profile-restart-'));
    const databasePath = join(root, 'control.sqlite');
    let store = new ProfileFileStore(root, new Database(databasePath) as unknown as SqliteDatabase, () => 123);
    try {
      store.applyLearning('learn:restart', 0, [proposal()], [source('a')]);
      const snapshot = captureProfileTurn(store, 'turn:restart', 'default', true);
      store.close();
      store = new ProfileFileStore(root, new Database(databasePath) as unknown as SqliteDatabase, () => 456);
      expect(store.inspect('user').entries[0]).toMatchObject({ authorship: 'learned', sources: [source('a')] });
      expect(captureProfileTurn(store, 'turn:restart', 'default', true)).toEqual(snapshot);
      store.applyLearning('learn:restart', 0, [proposal()], [source('a')]);
      expect(store.inspect('user').revision).toBe(1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

});
