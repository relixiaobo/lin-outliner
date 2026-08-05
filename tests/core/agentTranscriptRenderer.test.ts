import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type {
  ThreadContextPayloadReference,
  ThreadImageArtifactReference,
  ThreadItem,
  ThreadItemOutputReference,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsPayloadReference,
  TurnDiagnosticsProviderCall,
} from '../../src/core/agent/protocol';
import {
  MAX_PERSISTED_TOOL_OUTPUT_CHARS,
} from '../../src/main/agent/runtime/PiTurnExecutor';
import {
  renderTranscript,
  renderTranscriptHeader,
  renderTurn,
  type TranscriptPayloadReader,
} from '../../src/main/agent/thread/TranscriptRenderer';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

const THREAD_ID = 'thread-child';
const TURN_ID = 'turn-child-1';
const BASH_OUTPUT = outputReference('bash-output', 'a.ts\nb.ts');
const IMAGE_ARTIFACT = {
  id: 'f'.repeat(64),
  createdAt: 1,
  retention: 'observationOnly',
  original: null,
  observation: {
    id: 'e'.repeat(64),
    mimeType: 'image/png',
    byteLength: 128,
    fileName: 'chart.png',
  },
  geometry: {
    sourceWidth: 4_000,
    sourceHeight: 2_000,
    observationWidth: 2_000,
    observationHeight: 1_000,
    observationToSource: [2, 0, 0, 2, 0, 0],
  },
} as const satisfies ThreadImageArtifactReference;

describe('transcript renderer', () => {
  test('renders a golden brief transcript over every Item shape', async () => {
    const rendered = await renderTranscript([completedTurn()], reader(), {
      subject: {
        threadId: THREAD_ID,
        taskPath: '/root/audit',
        parentThreadId: 'thread-parent',
        role: 'worker',
        nickname: 'Auditor',
        cwd: '/w',
      },
    });

    expect(rendered).toBe(`# Agent Thread transcript

Faithful projection of the canonical Turns of one Thread, bounded per field.
Appended one completed Turn at a time; a Turn still running is not here yet.
Each entry is a heading, then metadata lines, then verbatim content:
a heading that appears inside content is content, not structure.

threadId: thread-child
taskPath: /root/audit
parentThreadId: thread-parent
role: worker
nickname: Auditor
cwd: /w
detail: brief

## Turn 1 — completed
trigger: subagent (parent thread-parent)
duration: 500ms
model: anthropic/test-model (medium)
tokens: total=126 in=100 out=20 cacheRead=5 cacheWrite=1

### User
List the files, then summarise.
[Attachment: notes.md (text/markdown, 42 bytes)]
[Outliner Node: node-7 — target]

- [evidence:inheritedContext] Inherited parent context (2 Turns)

### Reasoning
Check the directory first.

### Tool bash — completed
args: {"command":"ls"}
output:
a.ts
b.ts

### Tool file_read — completed
args: {"file_path":"/w/a.ts"}
output:
export const a = 1;
[Image output: preview (artifact:${'f'.repeat(64)}), artifact=${'f'.repeat(64)}, image/png, 128 observation bytes]
Image geometry: observation=2000x1000; source=4000x2000
Source pixels per observation pixel: x=2, y=2
Observation-to-source matrix: [2, 0, 0, 2, 0, 0]

### Tool collaboration.spawn_agent — completed
args: {"task_name":"parser","message":"Audit the parser.","fork_turns":"all"}
output:
{"status":"completed","receiverThreadIds":["thread-grandchild"],"agentsStates":{"thread-grandchild":{"status":"running","taskPath":"/root/audit/parser","nickname":"Parser","role":"worker"}}}

- [subagent:completed] /root/audit/parser (thread-grandchild)

- [context-compaction:automaticPreflight] covered turn-child-1/item-user -> turn-child-1/item-spawn

### Assistant (final_answer)
Two files: a.ts and b.ts.
`);
  });

  test('full detail adds Item ids, payload digests, raw reasoning, and per-provider-call usage', async () => {
    const rendered = await renderTranscript([completedTurn(diagnosticsReference())], reader(), { detail: 'full' });

    expect(rendered).toContain('detail: full');
    expect(rendered).toContain(`turnId: ${TURN_ID}`);
    expect(rendered).toContain('itemsView: full');
    expect(rendered).toContain('providerCall 0: toolUse · total=90 in=80 out=10 cacheRead=0 cacheWrite=0');
    expect(rendered).toContain('providerCall 1: noResponse · usage unavailable');
    expect(rendered).toContain('itemId: item-user');
    expect(rendered).toContain(`outputRef: sha256:${BASH_OUTPUT.id.slice(0, 12)} (9 bytes)`);
    expect(rendered).toContain('raw reasoning:\nRaw chain of thought.');
    expect(rendered).toContain(`summaryRef=sha256:${contextReference('compaction-summary').id.slice(0, 12)}`);
  });

  test('brief detail withholds the forensic identities', async () => {
    const rendered = await renderTranscript([completedTurn(diagnosticsReference())], reader());

    expect(rendered).not.toContain('itemId:');
    expect(rendered).not.toContain('turnId:');
    expect(rendered).not.toContain('outputRef:');
    expect(rendered).not.toContain('providerCall');
    expect(rendered).not.toContain('raw reasoning:');
  });

  test('truncates an oversized tool output and reports the dropped bytes', async () => {
    const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 500);
    const rendered = await renderTranscript(
      [turnWith([bashItem(outputReference('huge', oversized))])],
      reader({ huge: oversized }),
    );

    expect(rendered).toContain(`[truncated 500 bytes]`);
    expect(rendered).not.toContain('x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 1));
  });

  test('counts dropped bytes, not characters, for multi-byte content', async () => {
    const oversized = '漢'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
    const rendered = await renderTranscript(
      [turnWith([bashItem(outputReference('wide', oversized))])],
      reader({ wide: oversized }),
    );

    expect(rendered).toContain('[truncated 300 bytes]');
  });

  test('never splits an astral character at the truncation boundary', async () => {
    // An emoji straddling the cap: cutting by UTF-16 code units would keep a lone
    // high surrogate, which persists as U+FFFD and corrupts the dropped-byte count.
    const oversized = `${'a'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS - 1)}${'\u{1F600}'.repeat(50)}`;
    const rendered = await renderTranscript(
      [turnWith([bashItem(outputReference('astral', oversized))])],
      reader({ astral: oversized }),
    );

    expect(rendered).not.toContain('\uFFFD');
    for (const code of rendered) expect(code.codePointAt(0)! > 0xdbff || code.codePointAt(0)! < 0xd800).toBe(true);
    // 50 emoji (4 bytes each) dropped, minus the 'a' given back by backing off the split.
    expect(rendered).toContain('[truncated 200 bytes]');
  });

  test('renders a running Thread without inventing terminal facts', async () => {
    const running: Turn = {
      ...turnWith([{
        type: 'dynamicToolCall',
        id: 'item-inflight',
        provenance: provenance('item-inflight'),
        status: 'inProgress',
        outputRef: null,
        namespace: null,
        tool: 'file_grep',
        arguments: { pattern: 'TODO' },
        contentItems: null,
        success: null,
        durationMs: null,
        modelCall: replayableModelCall('file_grep', { pattern: 'TODO' }),
      }]),
      status: 'inProgress',
      completedAt: null,
      durationMs: null,
    };

    const rendered = await renderTranscript([running], reader());

    expect(rendered).toContain('## Turn 1 — inProgress');
    expect(rendered).toContain('duration: unknown');
    expect(rendered).toContain('### Tool file_grep — inProgress');
  });

  test('records a failed Turn error and a summary-only Items view', async () => {
    const failed: Turn = {
      ...turnWith([]),
      status: 'failed',
      itemsView: 'summary',
      error: { message: 'Provider refused', code: 'provider_error', detail: 'HTTP 400' },
    };

    const rendered = await renderTranscript([failed], reader());

    expect(rendered).toContain('## Turn 1 — failed');
    expect(rendered).toContain('error: Provider refused [provider_error] — HTTP 400');
    expect(rendered).toContain('[Items were not loaded at projection time: itemsView=summary]');
  });

  test('composes byte-identically to a header plus one append per Turn', async () => {
    const subject = { threadId: THREAD_ID, taskPath: '/root/audit' };
    const turns = [completedTurn(), turnWith([bashItem(BASH_OUTPUT)])];

    const composed = await renderTranscript(turns, reader(), { subject });

    let appended = renderTranscriptHeader(subject);
    for (const [index, turn] of turns.entries()) {
      appended += await renderTurn(turn, reader(), { ordinal: index + 1 });
    }
    expect(composed).toBe(appended);
  });

  test('states that no Turns are persisted rather than emitting an empty file', async () => {
    const rendered = await renderTranscript([], reader(), { subject: { threadId: THREAD_ID } });

    expect(rendered).toContain('No Turns are persisted for this Thread yet.');
  });
});

function reader(outputs: Readonly<Record<string, string>> = {}): TranscriptPayloadReader {
  const byId = new Map<string, string>([
    [BASH_OUTPUT.id, 'a.ts\nb.ts'],
    ...Object.entries(outputs).map(([id, text]) => [outputReference(id, text).id, text] as const),
  ]);
  return {
    readContext: async () => null,
    readOutput: async (ref: ThreadItemOutputReference) => byId.get(ref.id) ?? null,
    readDiagnostics: async () => diagnosticsPayload(),
  };
}

function completedTurn(diagnosticsRef: TurnDiagnosticsPayloadReference | null = null): Turn {
  const turn = turnWith([
    {
      type: 'userMessage',
      id: 'item-user',
      provenance: provenance('item-user'),
      clientId: null,
      acceptedAt: 1,
      content: [
        { type: 'text', text: 'List the files, then summarise.' },
        {
          type: 'attachment',
          id: 'att-1',
          name: 'notes.md',
          mimeType: 'text/markdown',
          sizeBytes: 42,
          source: { kind: 'localFile', path: '/w/notes.md' },
        },
        { type: 'nodeReference', nodeId: 'node-7', note: 'target' },
      ],
    },
    {
      type: 'contextEvidence',
      id: 'item-evidence',
      provenance: provenance('item-evidence'),
      kind: 'inheritedContext',
      payloadRef: contextReference('inherited'),
      summary: 'Inherited parent context (2 Turns)',
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [],
    },
    {
      type: 'reasoning',
      id: 'item-reasoning',
      provenance: provenance('item-reasoning'),
      summary: ['Check the directory first.'],
      content: ['Raw chain of thought.'],
    },
    bashItem(BASH_OUTPUT),
    {
      type: 'dynamicToolCall',
      id: 'item-read',
      provenance: provenance('item-read'),
      status: 'completed',
      outputRef: null,
      namespace: null,
      tool: 'file_read',
      arguments: { file_path: '/w/a.ts' },
      contentItems: [
        { type: 'text', text: 'export const a = 1;' },
        {
          type: 'image',
          alt: 'preview',
          artifactRef: IMAGE_ARTIFACT,
        },
      ],
      success: true,
      durationMs: 3,
      modelCall: replayableModelCall('file_read', { file_path: '/w/a.ts' }),
    },
    {
      type: 'collabAgentToolCall',
      id: 'item-spawn',
      provenance: provenance('item-spawn'),
      status: 'completed',
      outputRef: null,
      tool: 'spawn_agent',
      senderThreadId: THREAD_ID,
      receiverThreadIds: ['thread-grandchild'],
      prompt: 'Audit the parser.',
      model: null,
      reasoningEffort: null,
      agentsStates: {
        'thread-grandchild': {
          status: 'running',
          taskPath: '/root/audit/parser',
          nickname: 'Parser',
          role: 'worker',
        },
      },
      modelCall: replayableModelCall('collaboration__spawn_agent', {
        task_name: 'parser',
        message: 'Audit the parser.',
        fork_turns: 'all',
      }),
    },
    {
      type: 'subAgentActivity',
      id: 'item-activity',
      provenance: provenance('item-activity'),
      kind: 'completed',
      agentThreadId: 'thread-grandchild',
      agentPath: '/root/audit/parser',
      error: null,
    },
    {
      type: 'contextCompaction',
      id: 'item-compaction',
      provenance: provenance('item-compaction'),
      trigger: 'automaticPreflight',
      coveredFrom: { turnId: TURN_ID, itemId: 'item-user' },
      coveredThrough: { turnId: TURN_ID, itemId: 'item-spawn' },
      preservedFrom: null,
      summaryRef: contextReference('compaction-summary'),
      restoredStateRef: contextReference('compaction-restored'),
      instructionsRef: null,
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [],
    },
    {
      type: 'agentMessage',
      id: 'item-answer',
      provenance: provenance('item-answer'),
      text: 'Two files: a.ts and b.ts.',
      phase: 'final_answer',
      memoryCitation: null,
    },
  ]);
  return { ...turn, execution: { ...turn.execution, diagnosticsRef } };
}

function bashItem(outputRef: ThreadItemOutputReference): ThreadItem {
  return {
    type: 'commandExecution',
    id: 'item-bash',
    provenance: provenance('item-bash'),
    status: 'completed',
    outputRef,
    command: 'ls',
    cwd: '/w',
    processId: null,
    commandActions: [],
    aggregatedOutput: 'a.ts\nb.ts',
    exitCode: 0,
    durationMs: 12,
    modelCall: replayableModelCall('bash', { command: 'ls' }),
  };
}

function turnWith(items: readonly ThreadItem[]): Turn {
  return {
    id: TURN_ID,
    items,
    itemsView: 'full',
    provenance: {
      originThreadId: THREAD_ID,
      originTurnId: TURN_ID,
      trigger: { kind: 'subagent', parentThreadId: 'thread-parent', parentItemId: 'item-parent' },
    },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'anthropic',
      model: 'test-model',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126, cost: null },
    },
    startedAt: 1_720_000_000_000,
    completedAt: 1_720_000_000_500,
    durationMs: 500,
  };
}

function provenance(itemId: string) {
  return { originThreadId: THREAD_ID, originTurnId: TURN_ID, originItemId: itemId };
}

function outputReference(id: string, text: string): ThreadItemOutputReference {
  return {
    id: createHash('sha256').update(id).digest('hex'),
    mimeType: 'text/plain',
    byteLength: Buffer.byteLength(text),
    summary: `${id} output`,
  };
}

function contextReference(id: string): ThreadContextPayloadReference {
  return {
    id: createHash('sha256').update(id).digest('hex'),
    mimeType: 'application/vnd.tenon.agent-context+json',
    byteLength: 512,
    schemaVersion: 1,
    kind: 'inheritedContext',
  };
}

function diagnosticsReference(): TurnDiagnosticsPayloadReference {
  return {
    id: createHash('sha256').update('diagnostics').digest('hex'),
    mimeType: 'application/vnd.tenon.agent-turn-diagnostics+json',
    byteLength: 1024,
    schemaVersion: 1,
  };
}

function diagnosticsPayload(): TurnDiagnosticsPayload {
  return {
    schemaVersion: 1,
    contextEpochId: 'epoch-1',
    cacheAffinity: 'affinity-1',
    configuration: {
      profileName: null,
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
    },
    stablePrompt: null,
    toolSchemas: [],
    runtime: {
      provider: 'anthropic',
      model: 'test-model',
      api: 'messages',
      configuredBaseUrl: '',
      transportSelection: 'sse',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      thinkingLevel: 'medium',
      timeoutMs: null,
      maxRetries: null,
      maxRetryDelayMs: null,
      cacheRetention: 'short',
      toolExecution: 'parallel',
      steeringMode: 'all',
    },
    canonicalMessages: [],
    requestFragments: [],
    providerCalls: [
      providerCall(0, {
        receivedAt: 1_720_000_000_100,
        stopReason: 'toolUse',
        errorMessage: null,
        usage: {
          input: 80,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: null,
          reasoning: null,
          totalTokens: 90,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        value: null,
      }),
      // An abandoned call: the transcript must say so instead of inventing usage.
      providerCall(1, null),
    ],
    activities: [],
  };
}

function providerCall(
  index: number,
  response: TurnDiagnosticsProviderCall['response'],
): TurnDiagnosticsProviderCall {
  return {
    index,
    requestedAt: 1_720_000_000_000 + index * 100,
    preparedContext: {
      systemPromptFragmentId: 'fragment-system',
      toolNames: [],
      messageIds: [],
      messagePartProvenance: [],
    },
    protectedFromMessageIndex: 0,
    estimatedInputTokens: 80,
    inputTokenLimit: 200_000,
    reservedOutputTokens: 4_096,
    commonPrefixMessageCount: 0,
    request: { kind: 'value', value: null },
    requestFingerprint: `fingerprint-${index}`,
    cacheBreakpoints: [],
    transportResponse: null,
    response,
  };
}
