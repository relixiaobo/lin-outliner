import { randomUUID } from 'node:crypto';
import type { AssistantMessage, ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { AgentMessage } from '../core/agentTypes';
import {
  AGENT_EVENT_VERSION,
  getAgentEventActivePath,
  type AgentActor,
  type AgentEvent,
  type AgentEventReplayState,
  type AgentId,
  type AgentPersistedContent,
  type AgentRunKind,
  type AgentObjectiveStatus,
  type AgentRunBudget,
  type AgentRunPurpose,
  type AgentRunScope,
  type AgentRunLogEventType,
  type AgentRunStatus,
} from '../core/agentEventLog';
import type { AgentEventStore } from './agentEventStore';
import { persistedContentModelText } from './agentToolOutputSlimming';

// The write seam for a delegated (child) run's OWN ledger ([[agent-run-unification]]
// Design 1). A child run is an ordinary Run: its transcript is append-only run-log
// events in `runs/<runId>/events.jsonl`, in the run's own seq space, replayed alone
// into its own `AgentEventReplayState`. This module translates the live child
// agent's pi messages into those events as they complete (coarse per-message
// granularity — no streaming deltas; the sidechain UI refreshes per message, as the
// snapshot representation did).
//
// Ledger ordering encodes the Dream-evidence boundary STRUCTURALLY:
//   [fork context messages…, run.started, directive + child turns…]
// Events after the FIRST `run.started` are consolidation evidence; the copied fork
// prefix before it is inherited context (what `dreamEvidenceStartMessageIndex` used
// to express positionally — now stable under rename and compaction).

// Each terminal run status maps to exactly one run-ledger lifecycle event. The
// `satisfies Record<Exclude<…,'running'>, …>` makes this exhaustive: adding a new
// AgentRunStatus fails to compile here until it is mapped, instead of silently
// falling through to `run.cancelled` (the hazard of the prior nested ternary).
const TERMINAL_RUN_LIFECYCLE_EVENT = {
  completed: 'run.completed',
  failed: 'run.failed',
  cancelled: 'run.cancelled',
} as const satisfies Record<Exclude<AgentRunStatus, 'running'>, AgentRunLogEventType>;

interface RunLedgerRunState {
  conversationId: string;
  latestSeq: number;
  tailMessageId: string | null;
  /** Active-path message ids since the last compaction — the next compaction's source range. */
  pathMessageIds: string[];
  toolCallMessageIds: Map<string, string>;
  queue: Promise<void>;
}

export interface AgentRunLedgerStartInput {
  conversationId: string;
  runId: string;
  agentId: AgentId;
  /** The delegating run; absent for runs spawned outside any run (system-triggered). */
  parentRunId?: string;
  kind?: AgentRunKind;
  objective?: string;
  criteria?: string[];
  objectiveStatus?: AgentObjectiveStatus;
  purpose?: AgentRunPurpose;
  scope?: AgentRunScope;
  budget?: AgentRunBudget;
  actor: AgentActor;
  /** Inherited context (the fork prefix) — appended BEFORE `run.started`, excluded from Dream evidence. */
  contextMessages: readonly AgentMessage[];
  /** The directive (+ skill preloads) — appended AFTER `run.started`, part of Dream evidence. */
  evidenceMessages: readonly AgentMessage[];
}

export interface AgentRunLedgerContentPersister {
  persistUserContent(
    conversationId: string,
    runId: string,
    content: string | Array<TextContent | ImageContent>,
  ): Promise<AgentPersistedContent[]>;
  persistToolResultContent(
    conversationId: string,
    runId: string,
    toolCallId: string,
    toolName: string,
    content: Array<TextContent | ImageContent>,
  ): Promise<AgentPersistedContent[]>;
}

export interface AgentRunLedgerWriterOptions {
  store: () => AgentEventStore;
  persister: AgentRunLedgerContentPersister;
}

export class AgentRunLedgerWriter {
  private readonly runs = new Map<string, RunLedgerRunState>();

  constructor(private readonly options: AgentRunLedgerWriterOptions) {}

  /** Seed a brand-new child run's ledger: context, `run.started`, directive. */
  async runStarted(input: AgentRunLedgerStartInput): Promise<void> {
    const run: RunLedgerRunState = {
      conversationId: input.conversationId,
      latestSeq: 0,
      tailMessageId: null,
      pathMessageIds: [],
      toolCallMessageIds: new Map(),
      queue: Promise.resolve(),
    };
    this.runs.set(input.runId, run);
    await this.enqueue(input.runId, run, async () => {
      const events: AgentEvent[] = [];
      for (const message of input.contextMessages) {
        events.push(...await this.messageEvents(run, input.runId, message, input.actor));
      }
      events.push(this.buildEvent(run, input.runId, {
        type: 'run.started',
        actor: input.actor,
        runId: input.runId,
        agentId: input.agentId,
        anchor: { type: 'conversation', agentId: input.agentId, conversationId: run.conversationId },
        kind: input.kind ?? 'delegation',
        objective: input.objective,
        criteria: input.criteria,
        objectiveStatus: input.objectiveStatus,
        purpose: input.purpose,
        scope: input.scope,
        budget: input.budget,
        trigger: input.parentRunId ? { type: 'parent-run', parentRunId: input.parentRunId } : { type: 'system' },
      }));
      for (const message of input.evidenceMessages) {
        events.push(...await this.messageEvents(run, input.runId, message, input.actor));
      }
      await this.options.store().appendRunStreamEvents(run.conversationId, input.runId, events);
    });
  }

  /** Append one completed pi message (user / assistant / toolResult) to the ledger. */
  async appendMessage(runId: string, message: AgentMessage, actor: AgentActor): Promise<void> {
    const run = this.requireRun(runId);
    await this.enqueue(runId, run, async () => {
      const events = await this.messageEvents(run, runId, message, actor);
      if (events.length === 0) return;
      await this.options.store().appendRunStreamEvents(run.conversationId, runId, events);
    });
  }

  /**
   * Record a tool-output slimming replacement (`tool_result.replaced`): the ledger
   * stores what the model actually saw. Unknown tool calls are skipped — slimming
   * is an optimization, never worth failing the run over.
   */
  async replaceToolResult(runId: string, toolCallId: string, text: string, actor: AgentActor): Promise<void> {
    const run = this.requireRun(runId);
    await this.enqueue(runId, run, async () => {
      const messageId = run.toolCallMessageIds.get(toolCallId);
      if (!messageId) return;
      const event = this.buildEvent(run, runId, {
        type: 'tool_result.replaced',
        actor,
        runId,
        toolCallId,
        messageId,
        content: [{ type: 'text', text }],
        outputSummary: summarizeOutput(text),
      });
      await this.options.store().appendRunStreamEvents(run.conversationId, runId, [event]);
    });
  }

  /**
   * Event-sourced child compaction ([[agent-run-unification]] Design 4): append
   * `compaction.completed` + the post-compact user message as a NEW ROOT
   * (`parentMessageId: null`) — the reducer re-anchors the active path onto it and
   * the compacted span stays in the ledger off-path (evidence-preserving, §13.17
   * held structurally).
   */
  async compacted(
    runId: string,
    input: { postCompactMessage: AgentMessage; summary: string; trigger: 'auto' | 'reactive'; actor: AgentActor },
  ): Promise<void> {
    const run = this.requireRun(runId);
    await this.enqueue(runId, run, async () => {
      const fromMessageId = run.pathMessageIds[0];
      const throughMessageId = run.pathMessageIds.at(-1);
      const messageId = newMessageId('user');
      const events: AgentEvent[] = [];
      if (fromMessageId && throughMessageId) {
        events.push(this.buildEvent(run, runId, {
          type: 'compaction.completed',
          actor: input.actor,
          runId,
          messageId,
          summary: input.summary,
          source: { fromMessageId, throughMessageId },
          trigger: input.trigger,
        }));
      }
      const content = await this.userContent(run, runId, input.postCompactMessage);
      events.push(this.buildEvent(run, runId, {
        type: 'user_message.created',
        actor: input.actor,
        runId,
        messageId,
        parentMessageId: null,
        content,
      }));
      run.tailMessageId = messageId;
      run.pathMessageIds = [messageId];
      run.toolCallMessageIds.clear();
      await this.options.store().appendRunStreamEvents(run.conversationId, runId, events);
    });
  }

  /** Run lifecycle: terminal status (or a resume — `run.started` again). */
  async statusChanged(
    runId: string,
    status: AgentRunStatus,
    options: {
      actor: AgentActor;
      errorMessage?: string;
      agentId: AgentId;
      parentRunId?: string;
      objectiveStatus?: AgentObjectiveStatus;
      budget?: AgentRunBudget;
    },
  ): Promise<void> {
    const run = this.requireRun(runId);
    await this.enqueue(runId, run, async () => {
      const event = status === 'running'
        ? this.buildEvent(run, runId, {
            type: 'run.started',
            actor: options.actor,
            runId,
            agentId: options.agentId,
            anchor: { type: 'conversation', agentId: options.agentId, conversationId: run.conversationId },
            kind: 'delegation',
            trigger: options.parentRunId ? { type: 'parent-run', parentRunId: options.parentRunId } : { type: 'system' },
          })
        : this.buildEvent(run, runId, {
            type: TERMINAL_RUN_LIFECYCLE_EVENT[status],
            actor: options.actor,
            runId,
            errorMessage: options.errorMessage,
            objectiveStatus: options.objectiveStatus,
            budget: options.budget,
          });
      await this.options.store().appendRunStreamEvents(run.conversationId, runId, [event]);
    });
    // No eviction on terminal: a same-session resume reuses the live agent (and
    // this registration) directly. The map only ever holds runs spawned or
    // resumed in THIS session — restore-on-open is records-only — so it is
    // bounded by session activity, not run history.
  }

  /**
   * Mirror a restore-time interruption into the run's OWN ledger: the
   * conversation marks the run failed; without this the run stream (the
   * unified representation's source of truth for run lifecycle) would
   * self-describe as `running` forever. No-ops when the ledger is missing
   * (nothing to reconcile) or already terminal on its own stream.
   */
  async markInterrupted(
    conversationId: string,
    runId: string,
    options: { actor: AgentActor; errorMessage: string },
  ): Promise<void> {
    const state = await this.restore(conversationId, runId);
    if (!state) return;
    const status = state.runs[runId]?.status;
    if (status && status !== 'running') {
      this.runs.delete(runId);
      return;
    }
    const run = this.requireRun(runId);
    await this.enqueue(runId, run, async () => {
      const event = this.buildEvent(run, runId, {
        type: 'run.failed',
        actor: options.actor,
        runId,
        errorMessage: options.errorMessage,
      });
      await this.options.store().appendRunStreamEvents(run.conversationId, runId, [event]);
    });
    this.runs.delete(runId);
  }

  /**
   * Rebuild writer state from the ledger (restore on resume). Returns the
   * replayed state, or null when the ledger does not exist yet.
   */
  async restore(conversationId: string, runId: string): Promise<AgentEventReplayState | null> {
    const state = await this.options.store().replayRunStream(runId);
    if (state.latestSeq === 0) return null;
    const path = getAgentEventActivePath(state);
    const run: RunLedgerRunState = {
      conversationId,
      latestSeq: state.latestSeq,
      tailMessageId: path.at(-1)?.id ?? null,
      pathMessageIds: path.map((message) => message.id),
      toolCallMessageIds: new Map(
        path
          .filter((message) => message.role === 'toolResult' && message.toolCallId)
          .map((message) => [message.toolCallId!, message.id]),
      ),
      queue: Promise.resolve(),
    };
    this.runs.set(runId, run);
    return state;
  }

  /**
   * Register a run whose ledger does not exist yet — a conversation record
   * whose seed never landed (e.g. a crash inside the spawn window). The next
   * event (the resume's `run.started`) becomes the ledger's first event and
   * thus the Dream-evidence boundary: the continuation is the run's own work;
   * the lost original context stays lost.
   */
  register(conversationId: string, runId: string): void {
    if (this.runs.has(runId)) return;
    this.runs.set(runId, {
      conversationId,
      latestSeq: 0,
      tailMessageId: null,
      pathMessageIds: [],
      toolCallMessageIds: new Map(),
      queue: Promise.resolve(),
    });
  }

  /**
   * Quit-path settle: the in-flight tail of every registered run's ledger
   * queue, so a force-exit can await them alongside the conversation appends —
   * otherwise ⌘Q can persist the conversation-side terminal marker while the
   * ledger's own `run.completed` is cut mid-write and the run stream
   * self-reports running forever.
   */
  pendingWrites(): Promise<void>[] {
    return [...this.runs.values()].map((run) => run.queue);
  }

  forgetRun(runId: string): void {
    this.runs.delete(runId);
  }

  private requireRun(runId: string): RunLedgerRunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown child-run ledger: ${runId}`);
    return run;
  }

  private enqueue(runId: string, run: RunLedgerRunState, task: () => Promise<void>): Promise<void> {
    const next = run.queue.then(task, task);
    run.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async messageEvents(
    run: RunLedgerRunState,
    runId: string,
    message: AgentMessage,
    actor: AgentActor,
  ): Promise<AgentEvent[]> {
    if (message.role === 'user') {
      const messageId = newMessageId('user');
      const content = await this.userContent(run, runId, message);
      const event = this.buildEvent(run, runId, {
        type: 'user_message.created',
        actor,
        runId,
        messageId,
        parentMessageId: this.linkTail(run, messageId),
        content,
      });
      return [event];
    }
    if (message.role === 'assistant') {
      const assistant = message as AssistantMessage;
      const messageId = newMessageId('assistant');
      const parentMessageId = this.linkTail(run, messageId);
      const started = this.buildEvent(run, runId, {
        type: 'assistant_message.started',
        actor,
        runId,
        messageId,
        parentMessageId,
        providerId: assistant.provider ?? 'unknown',
        modelId: assistant.model ?? 'unknown',
        apiId: assistant.api,
      });
      const completed = this.buildEvent(run, runId, {
        type: 'assistant_message.completed',
        actor,
        runId,
        messageId,
        parentMessageId,
        stopReason: assistant.stopReason ?? 'stop',
        content: fromPiAssistantContent(assistant.content),
        usage: assistant.usage,
      });
      return [started, completed];
    }
    if (message.role === 'toolResult') {
      const messageId = newMessageId('tool-result');
      const content = await this.options.persister.persistToolResultContent(
        run.conversationId,
        runId,
        message.toolCallId,
        message.toolName,
        message.content as Array<TextContent | ImageContent>,
      );
      const event = this.buildEvent(run, runId, {
        type: 'tool_result.created',
        actor,
        runId,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        messageId,
        parentMessageId: this.linkTail(run, messageId),
        isError: message.isError === true,
        content,
        outputSummary: summarizeOutput(persistedContentModelText(content)),
      });
      run.toolCallMessageIds.set(message.toolCallId, messageId);
      return [event];
    }
    return [];
  }

  private async userContent(run: RunLedgerRunState, runId: string, message: AgentMessage): Promise<AgentPersistedContent[]> {
    const content = (message as { content: string | Array<TextContent | ImageContent> }).content;
    return this.options.persister.persistUserContent(run.conversationId, runId, content);
  }

  private linkTail(run: RunLedgerRunState, messageId: string): string | null {
    const parent = run.tailMessageId;
    run.tailMessageId = messageId;
    run.pathMessageIds.push(messageId);
    return parent;
  }

  private buildEvent(
    run: RunLedgerRunState,
    runId: string,
    input: Record<string, unknown> & { type: AgentEvent['type']; actor: AgentActor },
  ): AgentEvent {
    return {
      v: AGENT_EVENT_VERSION,
      eventId: randomUUID(),
      seq: ++run.latestSeq,
      conversationId: run.conversationId,
      createdAt: Date.now(),
      runId,
      ...input,
    } as AgentEvent;
  }
}

export function fromPiAssistantContent(content: AssistantMessage['content']): AgentPersistedContent[] {
  return content.map((part): AgentPersistedContent => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'thinking') return { type: 'thinking', thinking: part.thinking, redacted: part.redacted };
    return {
      type: 'toolCall',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
    };
  });
}

// Same clip convention as the conversation stream's `summarizeToolResult`
// (agentRuntime) — the `outputSummary` field must read identically no matter
// which stream wrote it (past-chats evidence and search prefer it).
function summarizeOutput(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 500).trim()}...`;
}

function newMessageId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
