/**
 * agent:dump — print the faithful transcript of one Agent Thread to stdout.
 *
 *   bun run agent:dump <userDataDir> <threadId> [--brief]
 *
 * Forensics as a command instead of a hand-written parser. It works for ANY
 * Thread in ANY state — root, Subagent, isolated Skill, completed, errored, or
 * still running — because it projects whatever the canonical log has persisted
 * so far. It shares ONE renderer with the transcript artifact
 * (`thread/TranscriptRenderer.ts`), so the operator and the parent model can
 * never be reading two different truths.
 *
 * Read-only by construction. The Thread's rollout JSONL is the only file
 * touched, read with the non-repairing `readSnapshot`, and the projection is
 * rebuilt in a throwaway in-memory database. A running app's SQLite files are
 * never opened, so no lock is taken and nothing on disk changes.
 */
import { Database } from 'bun:sqlite';
import type { ThreadId, Turn } from '../src/core/agent/protocol';
import { RolloutStore } from '../src/main/agent/persistence/RolloutStore';
import type { SqliteDatabase, SqliteValue } from '../src/main/agent/persistence/sqlite';
import { ThreadHistoryProjectionStore } from '../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ToolPayloadStore } from '../src/main/agent/persistence/ToolPayloadStore';
import { agentCorePaths } from '../src/main/agent/ThreadService';
import {
  renderTranscript,
  type TranscriptDetail,
  type TranscriptSubject,
} from '../src/main/agent/thread/TranscriptRenderer';

const USAGE = 'Usage: bun run agent:dump <userDataDir> <threadId> [--brief]';

async function main(argv: readonly string[]): Promise<number> {
  const detail: TranscriptDetail = argv.includes('--brief') ? 'brief' : 'full';
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  const [userDataDir, threadId] = positional;
  if (positional.length !== 2 || !userDataDir || !threadId) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const paths = agentCorePaths(userDataDir);
  const rollout = new RolloutStore(paths.rollouts);
  const entries = await rollout.readSnapshot(threadId);
  if (entries.length === 0) {
    process.stderr.write(`No rollout log for Thread ${threadId} under ${paths.rollouts}\n`);
    return 1;
  }

  const database = new Database(':memory:');
  const history = new ThreadHistoryProjectionStore(':memory:', bunSqliteAdapter(database));
  try {
    history.rebuildThread(threadId, entries);
    const payloads = new ToolPayloadStore(paths.payloads);
    const transcript = await renderTranscript(
      allTurns(history, threadId),
      {
        readOutput: (ref) => payloads.readTextReference(threadId, ref),
        readDiagnostics: (ref) => payloads.readTurnDiagnostics(threadId, ref),
      },
      { detail, subject: subjectFromRollout(threadId, entries) },
    );
    process.stdout.write(transcript);
    return 0;
  } finally {
    history.close();
  }
}

function allTurns(history: ThreadHistoryProjectionStore, threadId: ThreadId): Turn[] {
  const turns: Turn[] = [];
  let cursor: string | null = null;
  do {
    const page = history.listTurns({ threadId, cursor, limit: 100, itemsView: 'full' });
    turns.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return turns;
}

/**
 * The `thread/started` event carries the whole Thread record, so identity comes
 * from the same log as the Turns. `taskPath` lives in the spawn-edge metadata
 * database and is deliberately not read here; the transcript artifact written
 * at terminal state carries it.
 */
function subjectFromRollout(
  threadId: ThreadId,
  entries: Awaited<ReturnType<RolloutStore['readSnapshot']>>,
): TranscriptSubject {
  const started = entries.find((entry) => entry.event.type === 'thread/started');
  const thread = started?.event.type === 'thread/started' ? started.event.thread : null;
  return {
    threadId,
    role: thread?.agentRole ?? null,
    nickname: thread?.agentNickname ?? null,
    cwd: thread?.cwd ?? null,
  };
}

/** Bun ships `bun:sqlite`, not Node's `node:sqlite`, so the CLI adapts it. */
function bunSqliteAdapter(database: Database): SqliteDatabase {
  return {
    exec: (sql: string) => { database.exec(sql); },
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      return {
        run: (...params: readonly SqliteValue[]) => {
          const result = statement.run(...params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get: (...params: readonly SqliteValue[]) => statement.get(...params) ?? null,
        all: (...params: readonly SqliteValue[]) => statement.all(...params),
      };
    },
    close: () => { database.close(); },
  };
}

/**
 * Every failure exits through here rather than an unhandled rejection: a
 * malformed thread id and a torn rollout are this CLI's PRIMARY forensic
 * inputs, and a stack trace on those is a broken tool, not a diagnosis.
 */
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
  process.exitCode = 2;
}
