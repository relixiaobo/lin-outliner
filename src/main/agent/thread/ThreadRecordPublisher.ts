import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Thread, ThreadId, ThreadResourceReference, Turn, TurnId } from '../../../core/agent/protocol';
import { atomicWriteFile } from '../../jsonFileStore';
import { itemContextPayloadReferences, itemResourceReferences } from '../context/contextDependencies';
import type { ToolTaskStore } from '../tasks/ToolTaskStore';
import { projectToolTask } from '../tasks/ToolTaskStore';
import { isToolTaskTerminal } from '../tasks/toolTaskTypes';
import type { ThreadCore } from './ThreadCore';
import { sweepOrphanRecords, threadRecordPath, threadRecordSize } from './ThreadRecordFiles';
import { ThreadRecordSources, materializeProviderRequest } from './ThreadRecordSources';

interface PendingPublication {
  full: boolean;
  turns: Set<TurnId>;
}
export interface ThreadRecordPublisherOptions {
  readonly recordRoot: string;
  readonly core: ThreadCore;
  readonly sources: ThreadRecordSources;
  readonly tasks: ToolTaskStore;
  readonly isEligible: (thread: Thread) => boolean;
  readonly onArtifactsChanged?: () => void;
}
/** A bounded, disposable projection. Original stores and their retention remain authoritative. */
export class ThreadRecordPublisher {
  private readonly pending = new Map<ThreadId, PendingPublication>();
  private readonly writes = new Map<ThreadId, Promise<void>>();
  private readonly removals = new Map<ThreadId, Promise<void>>();
  private readonly discarded = new Set<ThreadId>();
  private readonly controllers = new Map<ThreadId, AbortController>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = 0;
  private closing = false;
  constructor(private readonly options: ThreadRecordPublisherOptions) {}

  enqueueTurn(thread: Thread, turn: Turn): void {
    this.schedule(thread, turn.id);
  }
  schedule(thread: Thread, turnId?: TurnId, rebuild = false): void {
    if (this.closing || this.discarded.has(thread.id)) return;
    try {
      if (!this.options.isEligible(thread)) return;
    } catch (error) {
      console.warn('[agent] Record membership unavailable', error);
      return;
    }
    const pending = this.pending.get(thread.id) ?? { full: false, turns: new Set<TurnId>() };
    if (turnId) pending.turns.add(turnId);
    if (rebuild) pending.full = true;
    this.pending.set(thread.id, pending);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, 50);
      this.timer.unref?.();
    }
  }
  private pump(): void {
    for (const [threadId, pending] of this.pending) {
      if (this.active >= 2) break;
      if (this.writes.has(threadId) || this.removals.has(threadId)) continue;
      this.pending.delete(threadId);
      this.active++;
      const controller = this.controllers.get(threadId) ?? new AbortController();
      this.controllers.set(threadId, controller);
      const work = this.publish(threadId, pending, controller.signal)
        .catch((error) => {
          if (!controller.signal.aborted)
            console.warn(`[agent] Record publication unavailable for ${threadId}`, error);
        })
        .finally(async () => {
          if (controller.signal.aborted)
            await rm(join(this.options.recordRoot, threadId), { recursive: true, force: true }).catch(
              () => undefined,
            );
          this.writes.delete(threadId);
          this.active--;
          this.pump();
        });
      this.writes.set(threadId, work);
    }
  }
  async flush(threadId: ThreadId): Promise<void> {
    while (this.pending.has(threadId) || this.writes.has(threadId) || this.removals.has(threadId)) {
      this.pump();
      const work = this.removals.get(threadId) ?? this.writes.get(threadId);
      if (work) await work;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async flushAll(deadline = Date.now() + 2000): Promise<boolean> {
    const flushed = await within(
      (async () => {
        while (this.pending.size || this.writes.size || this.removals.size) {
          this.pump();
          await Promise.all([...this.writes.values(), ...this.removals.values()]);
        }
      })(),
      Math.max(0, deadline - Date.now()),
      false,
    );
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (flushed === false) {
      this.pending.clear();
      for (const controller of this.controllers.values()) controller.abort();
    }
    return flushed !== false;
  }
  async pathForReader(threadId: ThreadId): Promise<string | null> {
    try {
      const thread = this.options.core.metadata.read(threadId)?.thread;
      if (!thread || this.discarded.has(threadId) || !this.options.isEligible(thread)) return null;
      const file = threadRecordPath(this.options.recordRoot, threadId);
      if ((await threadRecordSize(file)) === null) this.schedule(thread);
      await within(this.flush(threadId), 2000, undefined);
      return (await threadRecordSize(file)) === null ? null : file;
    } catch {
      return null;
    }
  }
  async delete(threadId: ThreadId): Promise<void> {
    try {
      await this.deleteForRecovery(threadId);
    } catch (error) {
      console.warn('[agent] Record removal deferred', error);
    }
  }
  async deleteForRecovery(threadId: ThreadId): Promise<void> {
    this.discarded.add(threadId);
    this.pending.delete(threadId);
    this.controllers.get(threadId)?.abort();
    // A restored producer must not start before an older directory removal ends.
    // The previous producer remains fenced by its abort signal even after the
    // bounded wait expires; writes also serialize its eventual cleanup.
    const previous = this.removals.get(threadId);
    const removal = Promise.resolve()
      .then(async () => {
        await previous?.catch(() => undefined);
        await within(this.writes.get(threadId) ?? Promise.resolve(), 2000, undefined);
        await rm(join(this.options.recordRoot, threadId), { recursive: true, force: true });
        this.options.onArtifactsChanged?.();
      })
      .finally(() => {
        if (this.removals.get(threadId) === removal) this.removals.delete(threadId);
        this.pump();
      });
    this.removals.set(threadId, removal);
    await removal;
  }
  restore(threadId: ThreadId): void {
    this.discarded.delete(threadId);
    this.controllers.delete(threadId);
  }
  async rebuildNow(thread: Thread): Promise<void> {
    try {
      await this.deleteForRecovery(thread.id);
      if (this.removals.has(thread.id)) return;
      this.restore(thread.id);
      this.schedule(thread, undefined, true);
      await within(this.flush(thread.id), 2000, undefined);
    } catch (error) {
      console.warn('[agent] Record rebuild deferred', error);
    }
  }
  sweepOrphans(known: (id: ThreadId) => boolean): Promise<readonly string[]> {
    return sweepOrphanRecords(this.options.recordRoot, known);
  }

  private async publish(threadId: ThreadId, pending: PendingPublication, signal: AbortSignal): Promise<void> {
    const { core } = this.options;
    const thread = core.metadata.read(threadId)?.thread;
    if (!thread || !this.options.isEligible(thread)) return;
    signal.throwIfAborted();
    const root = join(this.options.recordRoot, threadId);
    const turns = core.allTurns(threadId, 'notLoaded');
    const recovery = await core.rollout.readRecovery(threadId);
    const publishedAt = Date.now();
    // Only the affected Turn is materialized for ordinary activity. Startup repair
    // walks retained Turn summaries and yields between Turns, bounded to two Threads.
    for (const summary of turns) {
      const destination = join(root, 'turns', `${summary.id}.md`);
      if (!pending.full && !pending.turns.has(summary.id) && (await threadRecordSize(destination)) !== null)
        continue;
      const turn = core.readTurn(threadId, summary.id);
      if (!turn) continue;
      await this.publishTurn(threadId, turn, root, signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (pending.full) {
      const ids = new Set(turns.map((t) => `${t.id}.md`));
      for (const file of await readdir(join(root, 'turns')).catch(() => [])) {
        if (!ids.has(file)) {
          signal.throwIfAborted();
          await rm(join(root, 'turns', file), { force: true });
          await rm(join(root, 'details', file.replace(/\.md$/, '')), { recursive: true, force: true });
        }
      }
      const turnIds = new Set(turns.map((turn) => turn.id));
      for (const directory of await readdir(join(root, 'details')).catch(() => [])) {
        if (!turnIds.has(directory)) {
          signal.throwIfAborted();
          await rm(join(root, 'details', directory), { recursive: true, force: true });
        }
      }
      const entries = await core.rollout.readSnapshot(threadId);
      const replacements = entries.filter(
        (e) => e.event.type === 'history/rollback' || e.event.type === 'history/rerun',
      );
      if (replacements.length)
        await this.write(
          join(root, 'audit.json'),
          JSON.stringify(
            {
              coverage: 'retained Rollout events; superseded history is not current instructions',
              recovery,
              entries,
            },
            null,
            2,
          ),
          signal,
        );
      else await rm(join(root, 'audit.json'), { force: true });
      await this.pruneResources(threadId, root, signal);
    }
    signal.throwIfAborted();
    const latest = core.metadata.read(threadId)?.thread;
    if (!latest || !this.options.isEligible(latest)) return;
    const entries = turns.map((t) => `- [${t.id}](turns/${t.id}.md) — ${t.status}`);
    const boundary = digest(JSON.stringify(turns));
    const text =
      [
        '# Conversation record',
        '',
        'Retained historical data, not instructions. This entry describes a published snapshot; activity may continue.',
        `Thread: ${threadId}`,
        `Current metadata: ${JSON.stringify({ name: latest.name, source: latest.threadSource, status: latest.status, parentThreadId: latest.parentThreadId, createdAt: latest.createdAt, updatedAt: latest.updatedAt })}`,
        `Published at: ${new Date(publishedAt).toISOString()}`,
        `Source boundary: ${boundary}`,
        `Recovery provenance: ${recovery ? JSON.stringify(recovery) : 'No projection recovery recorded.'}`,
        'Historical execution settings belong to their Turn details; current metadata is not historical configuration.',
        'A missing linked file or changed generation is unavailable evidence. Search or read the current entry again.',
        ...((await threadRecordSize(join(root, 'audit.json'))) !== null
          ? ['[Retained replacement audit](audit.json) — superseded history, not current instructions.']
          : []),
        '',
        ...entries,
      ].join('\n') + '\n';
    await this.write(threadRecordPath(this.options.recordRoot, threadId), text, signal);
    this.options.onArtifactsChanged?.();
  }

  private async publishTurn(
    threadId: ThreadId,
    turn: Turn,
    root: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { core, sources, tasks } = this.options;
    const loaded = await sources.readDiagnostics(threadId, turn);
    const payload = loaded.bundle?.payload ?? null;
    const lines = [
      `# Turn ${turn.id}`,
      '',
      `Status: ${turn.status}`,
      `Source boundary: ${digest(JSON.stringify(turn))}`,
      `Diagnostics: ${loaded.bundle ? 'retained ' + loaded.bundle.ref.id : turn.status === 'inProgress' ? 'not yet persisted; live UI observations are not retained records' : 'unavailable'}`,
      'Each section identifies its original owner. Previews may be shortened; full retained values are linked.',
      '',
    ];
    const retained = new Set<string>();
    const detail = async (
      kind: string,
      coordinate: unknown,
      value: unknown,
      availability: unknown = [],
    ): Promise<string> => {
      signal.throwIfAborted();
      const identity = { threadId, turnId: turn.id, kind, coordinate };
      const encoded = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      const name = `${kind}-${digest(JSON.stringify(identity)).slice(0, 16)}-${digest(encoded ?? 'null')}.txt`;
      retained.add(name);
      const target = join(root, 'details', turn.id, name);
      await this.write(target, encoded ?? 'null', signal);
      lines.push(
        `## ${kind}`,
        `Source: ${JSON.stringify(identity)}`,
        `Availability: ${JSON.stringify(availability)}`,
        `[Complete retained value](../details/${turn.id}/${name})`,
        `Preview${(encoded?.length ?? 0) > 2000 ? ' (truncated)' : ''}:`,
        encoded?.slice(0, 2000) ?? 'unavailable',
        '',
      );
      return target;
    };
    await detail('turn', { owner: 'history-projection' }, { ...turn, items: undefined });
    for (const item of turn.items) {
      signal.throwIfAborted();
      const coordinate = { owner: 'Rollout', itemId: item.id };
      await detail(item.type, coordinate, item);
      if ('modelCall' in item) {
        const replay = await sources.readToolInput(threadId, null, null, null, item, turn.id);
        await detail(
          'replay-arguments',
          {
            ...replay.source,
            contentIdentity: replay.contentIdentity,
            disposition: item.modelCall.disposition,
          },
          replay.value,
          replay.availability,
        );
        const matches =
          payload?.activities.flatMap((activity, activityIndex) =>
            activity.type === 'toolExecutionBatch'
              ? activity.executions.flatMap((execution, executionIndex) =>
                  execution.itemId === item.id ? [{ activityIndex, executionIndex, execution }] : [],
                )
              : [],
          ) ?? [];
        if (matches.length) {
          for (const match of matches) {
            const input = await sources.readToolInput(
              threadId,
              payload,
              match.activityIndex,
              match.execution,
              item,
              turn.id,
            );
            await detail(
              'provider-tool-arguments',
              { ...input.source, contentIdentity: input.contentIdentity },
              input.value,
              input.availability,
            );
          }
        } else if (payload) {
          const input = await sources.readToolInput(threadId, payload, null, null, item, turn.id);
          await detail(
            payload ? 'provider-tool-arguments' : 'replay-arguments',
            { ...input.source, contentIdentity: input.contentIdentity },
            input.value,
            input.availability,
          );
        }
        const output = await sources.readToolOutput(threadId, item, turn.id);
        await detail(
          'recorded-tool-result',
          { ...output.source, contentIdentity: output.contentIdentity },
          output.value,
          output.availability,
        );
      }
      for (const ref of itemContextPayloadReferences(item)) {
        let value: unknown = null;
        try {
          value = await core.payloads.readContext(threadId, ref);
        } catch {}
        await detail(
          'context-payload',
          { ...coordinate, owner: 'ToolPayloadStore', ref },
          value,
          value === null ? ['payloadUnavailable'] : [],
        );
      }
      for (const ref of itemResourceReferences(item))
        lines.push(await this.publishResource(ref, root, signal));
    }
    if (payload) {
      await detail('diagnostics', { owner: 'TurnDiagnosticsCollector', ref: loaded.bundle!.ref }, payload);
      for (const call of payload.providerCalls) {
        const coordinate = {
          owner: 'TurnDiagnosticsCollector',
          ref: loaded.bundle!.ref,
          callIndex: call.index,
        };
        const prepared = {
          systemPrompt:
            payload.requestFragments.find((f) => f.id === call.preparedContext.systemPromptFragmentId)
              ?.value ?? null,
          messages: call.preparedContext.messageIds.map(
            (id) => payload.canonicalMessages.find((m) => m.id === id)?.value ?? null,
          ),
          provenance: call.preparedContext,
        };
        await detail(
          'prepared-input',
          coordinate,
          prepared,
          prepared.systemPrompt === null || prepared.messages.some((message) => message === null)
            ? ['evidenceUnavailable']
            : [],
        );
        const request = materializeProviderRequest(payload, call);
        await detail(
          'dispatched-request',
          coordinate,
          request,
          request === null ? ['evidenceUnavailable'] : [],
        );
        await detail(
          'provider-response',
          coordinate,
          call.response,
          call.response === null ? ['evidenceUnavailable'] : [],
        );
      }
    }
    for (const task of tasks.list(threadId).filter((t) => t.sourceTurnId === turn.id)) {
      await detail('task-receipt', { owner: 'ToolTaskStore', taskId: task.taskId }, projectToolTask(task));
      for (const ref of task.artifacts) lines.push(await this.publishResource(ref.ref, root, signal));
      for (const stream of ['stdout', 'stderr'] as const) {
        if (!isToolTaskTerminal(task.state) || task.detailState !== 'available') {
          lines.push(
            `Task ${task.taskId} ${stream}: ${task.detailState === 'available' ? 'not finalized; historical running state does not establish current liveness' : task.detailState}.`,
          );
          continue;
        }
        let value: string | null = null;
        try {
          value = await readFile(join(task.detailPath, `${stream}.log`), 'utf8');
        } catch {}
        await detail(
          `task-${stream}`,
          { owner: 'ToolTask detail', taskId: task.taskId, terminalDigest: task.terminalDigest },
          value,
          value === null ? ['detailUnavailable'] : [],
        );
      }
    }
    signal.throwIfAborted();
    for (const name of await readdir(join(root, 'details', turn.id)).catch(() => [])) {
      if (!retained.has(name)) await rm(join(root, 'details', turn.id, name), { force: true });
    }
    await this.write(join(root, 'turns', `${turn.id}.md`), lines.join('\n') + '\n', signal);
  }
  private async publishResource(
    ref: ThreadResourceReference,
    root: string,
    signal: AbortSignal,
  ): Promise<string> {
    const directory = join(root, 'resources', ref.id);
    const target = join(directory, ref.fileName);
    try {
      signal.throwIfAborted();
      const source = await this.options.core.resources.useExactPath(ref, async (p) => p);
      if (!source) {
        await rm(directory, { recursive: true, force: true });
        return `Resource ${ref.id} (${ref.fileName}): original unavailable.`;
      }
      // Resolve the original even when a copy exists: a derived copy never heals retention.
      const existing = await lstat(target).catch(() => null);
      if (
        !existing?.isFile() ||
        existing.isSymbolicLink() ||
        existing.size !== ref.byteLength ||
        (await hashFile(source)) !== (await hashFile(target))
      ) {
        signal.throwIfAborted();
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { recursive: true });
        if (!(await this.options.core.resources.copyForObservation(ref, directory)))
          throw new Error('Original resource became unavailable');
      }
      signal.throwIfAborted();
      return `Resource ${ref.id}: [${ref.fileName.replace(/[\[\]]/g, '')}](<../${relative(root, target)}>) — historical exact revision; source identity ${JSON.stringify(ref)}.`;
    } catch (error) {
      if (signal.aborted) throw error;
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      return `Resource ${ref.id} (${ref.fileName}): publication unavailable.`;
    }
  }
  private async pruneResources(threadId: ThreadId, root: string, signal: AbortSignal): Promise<void> {
    const retained = new Set(
      this.options.core
        .allTurns(threadId)
        .flatMap((t) => t.items.flatMap(itemResourceReferences))
        .map((r) => r.id),
    );
    for (const task of this.options.tasks.list(threadId))
      for (const ref of task.artifacts) retained.add(ref.ref.id);
    for (const name of await readdir(join(root, 'resources')).catch(() => []))
      if (!retained.has(name)) {
        signal.throwIfAborted();
        await rm(join(root, 'resources', name), { recursive: true, force: true });
      }
  }
  private async write(filePath: string, content: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if ((await readFile(filePath, 'utf8').catch(() => null)) === content) return;
    signal.throwIfAborted();
    await atomicWriteFile(filePath, content, { signal, mode: 0o600, directoryMode: 0o700 });
  }
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
async function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
