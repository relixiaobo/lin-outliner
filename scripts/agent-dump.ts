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
import type { ThreadId } from '../src/core/agent/protocol';
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

  // Bun ships `bun:sqlite`, not Node's `node:sqlite`; the shapes line up, which is
  // how the test suite opens these stores too.
  const database = new Database(':memory:') as unknown as SqliteDatabase;
  const history = new ThreadHistoryProjectionStore(':memory:', database);
  try {
    history.rebuildThread(threadId, entries);
    const payloads = new ToolPayloadStore(paths.payloads);
    const transcript = await renderTranscript(
      history.allTurns(threadId),
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
