import type { DocumentProjection } from '../../../core/types';
import { decodeThreadItem } from '../../../core/agent/codec';
import type {
  AdditionalContext,
  AdditionalContextPayload,
  ContextEvidenceThreadItem,
  ContextPayloadKind,
  RendererUserViewHints,
  RoleCatalogContextPayload,
  SkillCatalogContextPayload,
  SkillInvocationContextPayload,
  Thread,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadResourceReference,
  ThreadUserContent,
  TurnEnvironmentContextPayload,
  TurnId,
} from '../../../core/agent/protocol';
import type { ThreadContextContribution } from '../../../core/agent/extensions';
import {
  admitReferencedResources,
  type ReferencedAssetResolution,
} from '../capabilities/agentReferencedAssets';
import { buildUserViewPayload, nodeTitle } from './userView';
import { assertContextPayloadDependencies } from './contextDependencies';

export interface ContextEvidenceAdmissionResult {
  readonly items: readonly ContextEvidenceThreadItem[];
  readonly createdResourceRefs: readonly ThreadResourceReference[];
}

export async function admitContextEvidence(input: {
  readonly thread: Thread;
  readonly turnId: TurnId;
  readonly acceptedAt: number;
  readonly content: readonly ThreadUserContent[];
  readonly userView?: RendererUserViewHints;
  readonly additionalContext?: AdditionalContext;
  readonly extensionContext: readonly ThreadContextContribution[];
  readonly skillCatalog?: SkillCatalogContextPayload | null;
  readonly roleCatalog?: RoleCatalogContextPayload | null;
  readonly preloadedSkillInvocations?: readonly SkillInvocationContextPayload[];
  readonly skillInvocation?: SkillInvocationContextPayload | null;
  readonly includeHostContext: boolean;
  readonly projection: DocumentProjection | null;
  readonly locale?: string;
  readonly timeZone?: string;
  /** The name this participant answers to, resolved from configuration. */
  readonly persona?: string | null;
  readonly createItemId: () => string;
  readonly writeContext: (payload: ThreadContextPayload) => Promise<ThreadContextPayloadReference>;
  readonly resolveAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  readonly writeResource: (
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ) => Promise<{ readonly ref: ThreadResourceReference; readonly created: boolean }>;
  readonly onResourceCreated?: (ref: ThreadResourceReference) => void;
}): Promise<ContextEvidenceAdmissionResult> {
  const items: ContextEvidenceThreadItem[] = [];
  const createdResourceRefs: ThreadResourceReference[] = [];
  const publish = async (
    payload: ThreadContextPayload,
    summary: string,
    resourceRefs: readonly ThreadResourceReference[] = [],
  ) => {
    const payloadRef = await input.writeContext(payload);
    const item = contextEvidenceItem(input, payload.kind, payloadRef, summary, resourceRefs);
    assertContextPayloadDependencies(item, payload);
    items.push(item);
  };

  if (input.includeHostContext) {
    await publish(turnEnvironment(input), 'Turn environment');
  }

  const nodeReferences = input.content.flatMap((part) => (
    part.type === 'nodeReference' ? [{ nodeId: part.nodeId, note: part.note }] : []
  ));
  if (input.includeHostContext) {
    const userView = buildUserViewPayload(
      input.userView,
      input.projection,
      nodeReferences.map((reference) => reference.nodeId),
    );
    if (userView) await publish(userView, userViewSummary(userView));
    if (input.skillCatalog) {
      await publish(input.skillCatalog, `Available Skills (${input.skillCatalog.entries.length})`);
    }
    if (input.roleCatalog) {
      await publish(input.roleCatalog, `Available Roles (${input.roleCatalog.entries.length})`);
    }
    for (const invocation of input.preloadedSkillInvocations ?? []) {
      await publish(invocation, `Preloaded Skill: ${invocation.displayName}`);
    }
    if (input.skillInvocation) {
      await publish(input.skillInvocation, `Invoked Skill: ${input.skillInvocation.displayName}`);
    }
  }

  const additionalContext = additionalContextPayload(
    input.additionalContext,
    input.extensionContext,
    input.includeHostContext,
  );
  if (additionalContext) {
    await publish(
      additionalContext,
      `Additional context (${additionalContext.turnEntries.length} turn, ${additionalContext.threadState?.length ?? 0} state)`,
    );
  }

  if (input.includeHostContext && nodeReferences.length > 0) {
    const referenced = await admitReferencedResources({
      projection: input.projection,
      references: nodeReferences,
      resolveAsset: input.resolveAsset,
      writeResource: input.writeResource,
    });
    if (referenced) {
      createdResourceRefs.push(...referenced.createdResourceRefs);
      for (const ref of referenced.createdResourceRefs) input.onResourceCreated?.(ref);
      await publish(
        referenced.payload,
        `Referenced resources (${referenced.payload.resources.length})`,
        referenced.resourceRefs,
      );
    }
  }

  return { items, createdResourceRefs };
}

function turnEnvironment(input: {
  readonly thread: Thread;
  readonly acceptedAt: number;
  readonly projection: DocumentProjection | null;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly persona?: string | null;
}): TurnEnvironmentContextPayload {
  const instant = new Date(input.acceptedAt);
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const locale = input.locale ?? resolved.locale ?? 'en-US';
  const timeZone = input.timeZone ?? resolved.timeZone ?? 'Etc/UTC';
  const parts = dateTimeParts(instant, locale, timeZone);
  const todayNode = input.projection?.nodes.find((node) => node.id === input.projection?.todayId) ?? null;
  return {
    schemaVersion: 1,
    kind: 'turnEnvironment',
    acceptedAt: input.acceptedAt,
    utcInstant: instant.toISOString(),
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    timeZone,
    utcOffsetMinutes: timeZoneOffsetMinutes(instant, timeZone),
    locale,
    workingDirectory: input.thread.cwd,
    conversationMode: input.thread.parentThreadId === null && input.thread.threadSource === 'user'
      ? 'interactive'
      : 'headless',
    executionMode: executionMode(input.thread),
    // The configured name, not a constant: the reader is told who they are
    // talking to by the header, and the agent must not answer with a different
    // name when asked. An isolated Skill keeps its own name, which IS what it is.
    replyIdentity: input.persona?.trim()
      || (input.thread.parentThreadId === null
        ? null
        : input.thread.agentNickname ?? input.thread.agentRole),
    todayNodeId: input.projection?.todayId ?? null,
    todayNodeTitle: todayNode ? nodeTitle(todayNode) : null,
  };
}

function additionalContextPayload(
  direct: AdditionalContext | undefined,
  extensions: readonly ThreadContextContribution[],
  includeThreadState: boolean,
): AdditionalContextPayload | null {
  const turnEntries = Object.entries(direct ?? {}).map(([key, entry]) => ({
    key,
    source: entry.kind === 'application' ? 'main' : 'renderer',
    authority: entry.kind,
    purpose: entry.kind === 'application' ? 'instruction' as const : 'observation' as const,
    text: entry.value,
  }))
    .sort((left, right) => compareStableText(left.key, right.key));
  const threadState = includeThreadState && extensions.length > 0
    ? extensions.flatMap((contribution) => Object.entries(contribution.additionalContext).map(([key, entry]) => ({
        key: `${contribution.extensionId}:${key}`,
        source: `extension:${contribution.extensionId}`,
        authority: entry.kind,
        purpose: entry.kind === 'application' ? 'instruction' as const : 'observation' as const,
        text: entry.value,
      }))).sort((left, right) => compareStableText(left.key, right.key))
    : null;
  return turnEntries.length > 0 || threadState !== null
    ? { schemaVersion: 1, kind: 'additionalContext', turnEntries, threadState }
    : null;
}

export function contextEvidenceItem(
  input: { readonly thread: Thread; readonly turnId: TurnId; readonly createItemId: () => string },
  kind: ContextPayloadKind,
  payloadRef: ThreadContextPayloadReference,
  summary: string,
  resourceRefs: readonly ThreadResourceReference[],
  dependencies: {
    readonly contextRefs?: readonly ThreadContextPayloadReference[];
    readonly outputRefs?: readonly import('../../../core/agent/protocol').ThreadItemOutputReference[];
  } = {},
): ContextEvidenceThreadItem {
  const id = input.createItemId();
  return decodeThreadItem({
    type: 'contextEvidence',
    id,
    provenance: {
      originThreadId: input.thread.id,
      originTurnId: input.turnId,
      originItemId: id,
    },
    kind,
    payloadRef,
    summary,
    contextRefs: dependencies.contextRefs ?? [],
    resourceRefs,
    outputRefs: dependencies.outputRefs ?? [],
  }) as ContextEvidenceThreadItem;
}

function userViewSummary(payload: NonNullable<ReturnType<typeof buildUserViewPayload>>): string {
  const visible = payload.panels.reduce((total, panel) => total + panel.visibleOutline.length, 0);
  return `User view (${payload.panels.length} panels, ${visible} visible Nodes)`;
}

function executionMode(thread: Thread): TurnEnvironmentContextPayload['executionMode'] {
  if (thread.parentThreadId !== null) return 'child';
  if (thread.threadSource === 'memory_consolidation') return 'memory';
  if (thread.threadSource === 'subagent') return 'child';
  if (thread.threadSource === 'user') return 'root';
  return thread.source === 'automation' ? 'automation' : 'feature';
}

function dateTimeParts(instant: Date, locale: string, timeZone: string) {
  const values = new Map(new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const required = (key: Intl.DateTimeFormatPartTypes) => values.get(key)
    ?? (() => { throw new Error(`Missing ${key} date part`); })();
  return {
    year: required('year'),
    month: required('month'),
    day: required('day'),
    hour: required('hour'),
    minute: required('minute'),
    second: required('second'),
  };
}

function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const values = new Map(new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(instant).map((part) => [part.type, part.value]));
  const match = values.get('timeZoneName')?.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2}))?$/u);
  if (!match?.groups?.sign) return 0;
  const offset = Number(match.groups.hours) * 60 + Number(match.groups.minutes);
  return match.groups.sign === '-' ? -offset : offset;
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
