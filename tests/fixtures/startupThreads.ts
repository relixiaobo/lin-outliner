import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uuidV7 } from '../../src/main/agent/uuid';
import { ThreadService } from '../../src/main/agent/ThreadService';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import { openSqlite, closeSqliteAfterFailure } from '../../src/main/agent/persistence/sqlite';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';

// The fixture runs in Bun; Electron verification reopens these bytes with Node SQLite.
mock.module('../../src/main/agent/persistence/sqlite', () => ({
  closeSqliteAfterFailure,
  openSqlite: (path: string) => {
    const database = new Database(path);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    return database;
  },
}));
const root = process.argv[2]!;
const service = await ThreadService.open(root, { execute: async () => ({ status: 'completed' }) }, {
  extensions: new ExtensionRegistry(), attachmentScratchRoot: join(root, 'agent-scratch'),
});
await service.initialize();
const names = ['Healthy conversation', 'Unreadable conversation'];
const ids: string[] = [];
for (const name of names) {
  const { thread } = await service.startThread({ source: 'app', threadSource: 'user', name,
    modelProvider: 'openai', configurationSource: { kind: 'user' } });
  ids.push(thread.id);
  await service.startRendererTurn({ threadId: thread.id, input: [{ type: 'text', text: 'Local fixture only' }] });
  await service.waitForIdle(thread.id);
}
await service.close();
const [healthyId, unreadableId] = ids as [string, string];
const childId = uuidV7();
const metadata = new ThreadMetadataStore(join(root, 'agent/state.sqlite'));
const parent = metadata.require(unreadableId);
metadata.createChild({ ...parent, thread: { ...parent.thread, id: childId, sessionId: childId,
  parentThreadId: unreadableId, threadSource: 'delegation', name: 'Affected child',
  configurationSource: { kind: 'user' } } },
  { parentThreadId: unreadableId, childThreadId: childId, sessionId: childId,
    taskPath: 'fixture-child', createdAt: Date.now() });
metadata.close();
const rollout = join(root, 'agent/rollouts', `${unreadableId}.jsonl`);
const text = await readFile(rollout, 'utf8');
function removeAuthors(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.type === 'userMessage') delete record.author;
  Object.values(record).forEach(removeAuthors);
}
await writeFile(rollout, text.trimEnd().split('\n').map((line) => {
  const record = JSON.parse(line); removeAuthors(record); return JSON.stringify(record);
}).join('\n') + '\n');
const history = openSqlite(join(root, 'agent/thread_history.sqlite'));
history.prepare("UPDATE thread_items SET item_json = json_remove(item_json, '$.author') WHERE thread_id = ?").run(unreadableId);
history.close();
console.log(JSON.stringify({ healthyId, unreadableId, childId }));
