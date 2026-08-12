import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '../runtime/kernel/types';
import type {
  ContextEvidenceThreadItem,
  ContextCompactionThreadItem,
  ContextDegradationCheckpointEntry,
  ContextAuthority,
  ContextPayloadKind,
  ContextPurpose,
  ContextTextEntry,
  JsonValue,
  ReferencedResourcesContextPayload,
  RoleCatalogContextPayload,
  SkillCatalogContextPayload,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ToolOutputProjectionContextPayload,
  ThreadItem,
  ThreadImageArtifactReference,
  ThreadResourceReference,
  ThreadUserContent,
  Turn,
  TurnDiagnosticsMessagePartProvenance,
  TurnDiagnosticsSystemContextEntry,
  TurnEnvironmentContextPayload,
  UserViewContextPayload,
} from '../../../core/agent/protocol';
import { modelCallArgumentSource } from '../../../core/agent/modelCallHistory';
import { escapeXml } from '../../../core/reminderXml';
import {
  formatFileReferenceMarker,
  formatNodeReferenceMarker,
} from '../../../core/referenceMarkup';
import { assertContextPayloadDependencies, outputReferenceKey } from './contextDependencies';
import { selectEffectiveContext } from './ContextEpoch';
import { restoreRoleCatalogCheckpoint } from './RoleContextReducer';
import { restoreSkillCatalogCheckpoint } from './SkillContextReducer';
import { assertCanonicalUserContent } from './userContentIntegrity';
import {
  contextDegradation,
  renderContextDegradation,
} from './ContextDegradation';
import {
  boundedRedactedJsonSummary,
  evidenceCorrection,
  redactedReplayMarker,
} from '../runtime/toolCallHistory';
import { redactSecretLikeJsonAsync } from '../capabilities/agentSecretRedaction';

interface ProjectionResources {
  readContext(ref: ThreadContextPayloadReference): Promise<ThreadContextPayload | null>;
  readOutput(ref: ToolOutputProjectionContextPayload['outputRef']): Promise<string | null>;
  readResource(ref: ThreadResourceReference): Promise<Buffer | null>;
  resolveResourceObservationPath(ref: ThreadResourceReference): Promise<string | null>;
  resolveImageArtifactPath(artifact: ThreadImageArtifactReference): Promise<string | null>;
}

export interface LiveModelToolCall {
  readonly providerName: string;
  readonly arguments: JsonValue;
}

export interface CanonicalContextProjectorOptions {
  readonly liveToolCall?: (turnId: string, itemId: string) => LiveModelToolCall | null;
}

interface ProjectedContextBlock extends TurnDiagnosticsSystemContextEntry {
  readonly type: 'contextBlock';
  readonly body: string;
  readonly metadata: readonly string[];
}

interface ProjectedContextImage {
  readonly type: 'contextImage';
  readonly content: ImageContent;
  readonly entry: TurnDiagnosticsSystemContextEntry;
}

type ProjectedContextPart = ProjectedContextBlock | ProjectedContextImage;

export interface ProjectedTurnBoundary {
  readonly turnId: string;
  readonly messageIndex: number;
}

export interface ProjectedUserBoundary extends ProjectedTurnBoundary {
  readonly itemId: string;
}

export interface ProjectedAssistantBoundary extends ProjectedTurnBoundary {
  readonly itemIds: readonly string[];
}

export interface CanonicalContextProjection {
  readonly messages: Message[];
  readonly messagePartProvenance: readonly (readonly TurnDiagnosticsMessagePartProvenance[])[];
  readonly turnBoundaries: readonly ProjectedTurnBoundary[];
  readonly userBoundaries: readonly ProjectedUserBoundary[];
  readonly assistantBoundaries: readonly ProjectedAssistantBoundary[];
}

export class CanonicalContextProjector {
  private previousEnvironment: TurnEnvironmentContextPayload | null = null;
  private previousUserView: UserViewContextPayload | null = null;
  private previousAdditionalContext: ReadonlyMap<string, ContextTextEntry> | null = null;
  private readonly payloads = new Map<string, ThreadContextPayload>();
  private readonly toolOutputProjections = new Map<string, ToolOutputProjectionContextPayload>();
  private readonly unavailableToolOutputProjections = new Set<string>();
  private readonly conflictingToolOutputProjections = new Set<string>();
  private readonly unavailableToolOutputProjectionItems = new Set<string>();

  constructor(
    private readonly model: Model<Api>,
    private readonly resources: ProjectionResources,
    private readonly options: CanonicalContextProjectorOptions = {},
  ) {}

  async projectTurns(turns: readonly Turn[]): Promise<Message[]> {
    return (await this.projectTurnsWithBoundaries(turns)).messages;
  }

  async projectTurnsWithBoundaries(turns: readonly Turn[]): Promise<CanonicalContextProjection> {
    const selectedTurns = selectEffectiveContext(turns).turns;
    await this.prepareToolOutputProjections(selectedTurns);
    const messages: Message[] = [];
    const messagePartProvenance: TurnDiagnosticsMessagePartProvenance[][] = [];
    const turnBoundaries: ProjectedTurnBoundary[] = [];
    const userBoundaries: ProjectedUserBoundary[] = [];
    const assistantBoundaries: ProjectedAssistantBoundary[] = [];
    for (const turn of selectedTurns) {
      const projected = await this.projectTurn(turn, turns);
      if (projected.messages.length === 0) continue;
      turnBoundaries.push({ turnId: turn.id, messageIndex: messages.length });
      userBoundaries.push(...projected.userBoundaries.map((boundary) => ({
        ...boundary,
        messageIndex: messages.length + boundary.messageIndex,
      })));
      assistantBoundaries.push(...projected.assistantBoundaries.map((boundary) => ({
        ...boundary,
        messageIndex: messages.length + boundary.messageIndex,
      })));
      messages.push(...projected.messages);
      messagePartProvenance.push(...projected.messagePartProvenance);
    }
    return { messages, messagePartProvenance, turnBoundaries, userBoundaries, assistantBoundaries };
  }

  private async prepareToolOutputProjections(turns: readonly Turn[]): Promise<void> {
    this.toolOutputProjections.clear();
    this.unavailableToolOutputProjections.clear();
    this.conflictingToolOutputProjections.clear();
    this.unavailableToolOutputProjectionItems.clear();
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type === 'contextReset') {
          this.toolOutputProjections.clear();
          this.unavailableToolOutputProjections.clear();
          this.conflictingToolOutputProjections.clear();
          this.unavailableToolOutputProjectionItems.clear();
          continue;
        }
        if (item.type !== 'contextEvidence' || item.kind !== 'toolOutputProjection') continue;
        const declaredKeys = item.outputRefs.map(outputReferenceKey);
        const markUnavailable = () => {
          for (const key of declaredKeys) {
            if (!this.toolOutputProjections.has(key)) this.unavailableToolOutputProjections.add(key);
          }
        };
        const payload = await this.readEvidencePayload(item).catch(() => null);
        if (!payload || payload.kind !== 'toolOutputProjection') {
          console.warn(`[agent] Skipping unavailable tool-output projection: ${item.payloadRef.id}`);
          this.unavailableToolOutputProjectionItems.add(item.id);
          markUnavailable();
          continue;
        }
        const key = outputReferenceKey(payload.outputRef);
        if (this.conflictingToolOutputProjections.has(key)) continue;
        const existing = this.toolOutputProjections.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(payload)) {
          console.warn(`[agent] Skipping conflicting tool-output projection: ${payload.outputRef.id}`);
          this.toolOutputProjections.delete(key);
          this.unavailableToolOutputProjections.add(key);
          this.conflictingToolOutputProjections.add(key);
          continue;
        }
        this.toolOutputProjections.set(key, payload);
        this.unavailableToolOutputProjections.delete(key);
      }
    }
  }

  async projectUserItems(
    items: readonly ThreadItem[],
    fallbackTimestamp: number,
  ): Promise<UserMessage> {
    const content: Array<TextContent | ImageContent> = [];
    let contextBlocks: ProjectedContextBlock[] = [];
    const flushContextBlocks = () => {
      if (contextBlocks.length === 0) return;
      content.push(contextBundle(contextBlocks));
      contextBlocks = [];
    };
    let timestamp = fallbackTimestamp;
    for (const item of items) {
      if (item.type === 'contextEvidence') {
        const parts = await this.projectEvidence(item).catch(() => [this.degradationPart(
          item.kind,
          contextDegradation('payloadUnavailable', item.kind, item.payloadRef.id),
        )]);
        for (const part of parts) {
          if (part.type === 'contextBlock') {
            contextBlocks.push(part);
          } else {
            flushContextBlocks();
            content.push(part.content);
          }
        }
      } else if (item.type === 'userMessage') {
        flushContextBlocks();
        timestamp = item.acceptedAt;
        content.push(...await serializeUserContent(item.content, this.resources));
      }
    }
    flushContextBlocks();
    if (content.length === 0) content.push({ type: 'text', text: 'Continue.' });
    return { role: 'user', content, timestamp };
  }

  private async projectTurn(turn: Turn, sourceTurns: readonly Turn[]): Promise<{
    readonly messages: Message[];
    readonly messagePartProvenance: TurnDiagnosticsMessagePartProvenance[][];
    readonly userBoundaries: ProjectedUserBoundary[];
    readonly assistantBoundaries: ProjectedAssistantBoundary[];
  }> {
    const messages: Message[] = [];
    const messagePartProvenance: TurnDiagnosticsMessagePartProvenance[][] = [];
    const userBoundaries: ProjectedUserBoundary[] = [];
    const assistantBoundaries: ProjectedAssistantBoundary[] = [];
    let pendingUserContent: Array<TextContent | ImageContent> = [];
    let pendingUserProvenance: TurnDiagnosticsMessagePartProvenance[] = [];
    let pendingContextBlocks: ProjectedContextBlock[] = [];
    let assistantContent: Array<TextContent | ToolCall> = [];
    let assistantItemIds: string[] = [];
    let toolResults: ToolResultMessage[] = [];
    let toolEvidence: string[] = [];
    const flushContextBlocks = () => {
      if (pendingContextBlocks.length === 0) return;
      pendingUserContent.push(contextBundle(pendingContextBlocks));
      pendingUserProvenance.push(systemContextProvenance(pendingContextBlocks));
      pendingContextBlocks = [];
    };
    const appendContextParts = (parts: readonly ProjectedContextPart[]) => {
      for (const part of parts) {
        if (part.type === 'contextBlock') {
          pendingContextBlocks.push(part);
        } else {
          flushContextBlocks();
          pendingUserContent.push(part.content);
          pendingUserProvenance.push({ source: 'systemContext', entries: [part.entry] });
        }
      }
    };
    const flushAssistant = () => {
      if (assistantContent.length > 0) {
        const messageIndex = messages.length;
        messages.push(assistantHistoryMessage(
          assistantContent,
          turn.startedAt,
          this.model,
          toolResults.length > 0 ? 'toolUse' : 'stop',
        ));
        messagePartProvenance.push(assistantContent.map(() => ({ source: 'assistantHistory' })));
        assistantBoundaries.push({ turnId: turn.id, messageIndex, itemIds: assistantItemIds });
      }
      for (const result of toolResults) {
        messages.push(result);
        messagePartProvenance.push(result.content.map(() => ({ source: 'toolResult' })));
      }
      for (const evidence of toolEvidence) {
        messages.push({ role: 'user', content: [{ type: 'text', text: evidence }], timestamp: turn.startedAt });
        messagePartProvenance.push([{ source: 'unknown' }]);
      }
      assistantContent = [];
      assistantItemIds = [];
      toolResults = [];
      toolEvidence = [];
    };
    const flushPendingUser = (timestamp: number) => {
      flushContextBlocks();
      flushAssistant();
      if (pendingUserContent.length === 0) {
        pendingUserContent.push({ type: 'text', text: 'Continue.' });
        pendingUserProvenance.push({ source: 'unknown' });
      }
      const messageIndex = messages.length;
      messages.push({ role: 'user', content: pendingUserContent, timestamp });
      messagePartProvenance.push(pendingUserProvenance);
      pendingUserContent = [];
      pendingUserProvenance = [];
      return messageIndex;
    };

    for (const item of turn.items) {
      if (item.type === 'contextEvidence') {
        if (item.kind === 'inheritedContext') {
          if (pendingUserContent.length > 0 || pendingContextBlocks.length > 0) flushPendingUser(turn.startedAt);
          else flushAssistant();
          const payload = await this.readEvidencePayload(item).catch(() => null);
          if (!payload || payload.kind !== 'inheritedContext') {
            appendContextParts([this.degradationPart(
              'inheritedContext',
              contextDegradation(
                payload ? 'payloadInvalid' : 'payloadUnavailable',
                'inheritedContext',
                item.payloadRef.id,
              ),
            )]);
            continue;
          }
          const inheritedProjector = new CanonicalContextProjector(this.model, this.resources, this.options);
          const inherited = await inheritedProjector.projectTurnsWithBoundaries(payload.turns);
          messages.push(...inherited.messages);
          messagePartProvenance.push(...inherited.messagePartProvenance.map((parts) => [...parts]));
          continue;
        }
        if (
          item.kind === 'toolOutputProjection'
          && (
            this.unavailableToolOutputProjectionItems.has(item.id)
            || item.outputRefs.some((ref) => this.unavailableToolOutputProjections.has(outputReferenceKey(ref)))
          )
        ) {
          appendContextParts([this.degradationPart(
            'toolOutputProjection',
            contextDegradation('payloadUnavailable', 'toolOutputProjection', item.payloadRef.id),
          )]);
          continue;
        }
        appendContextParts(await this.projectEvidence(item).catch(() => [this.degradationPart(
          item.kind,
          contextDegradation('payloadUnavailable', item.kind, item.payloadRef.id),
        )]));
        continue;
      }
      if (item.type === 'userMessage') {
        flushContextBlocks();
        const userContent = await serializeUserContent(item.content, this.resources);
        pendingUserContent.push(...userContent);
        pendingUserProvenance.push(...userContent.map(() => ({ source: 'userInput' as const })));
        userBoundaries.push({
          turnId: turn.id,
          itemId: item.id,
          messageIndex: flushPendingUser(item.acceptedAt),
        });
        continue;
      }
      if (item.type === 'contextReset') {
        if (toolResults.length > 0 || toolEvidence.length > 0) flushAssistant();
        pendingUserContent = [];
        pendingUserProvenance = [];
        pendingContextBlocks = [];
        this.previousEnvironment = null;
        this.previousUserView = null;
        this.previousAdditionalContext = null;
        continue;
      }
      if (item.type === 'contextCompaction') {
        appendContextParts(await this.projectCompaction(item, sourceTurns).catch(() => [this.degradationPart(
          'compactionRestoredState',
          contextDegradation('payloadInvalid', 'compactionRestoredState', item.restoredStateRef.id),
        )]));
        continue;
      }
      if (pendingUserContent.length > 0 || pendingContextBlocks.length > 0) flushPendingUser(turn.startedAt);
      if (isToolItem(item)) {
        const projectionKey = item.outputRef ? outputReferenceKey(item.outputRef) : null;
        const projection = projectionKey
          ? this.toolOutputProjections.get(projectionKey) ?? null
          : null;
        const tool = await historyTool(
          item,
          turn.startedAt,
          this.resources,
          projection,
          projectionKey !== null && this.unavailableToolOutputProjections.has(projectionKey),
          this.options.liveToolCall?.(turn.id, item.id) ?? null,
        );
        if (tool.kind === 'evidence') {
          toolEvidence.push(tool.text);
          continue;
        }
        assistantItemIds.push(item.id);
        if (tool.marker) assistantContent.push(tool.marker);
        assistantContent.push(tool.call);
        toolResults.push(tool.result);
        continue;
      }
      if (toolResults.length > 0 || toolEvidence.length > 0) flushAssistant();
      switch (item.type) {
        case 'agentMessage':
          if (item.phase === 'interrupted') break;
          assistantItemIds.push(item.id);
          if (item.text) assistantContent.push({ type: 'text', text: item.text });
          break;
        case 'reasoning':
          assistantItemIds.push(item.id);
          break;
        case 'subAgentActivity':
          assistantItemIds.push(item.id);
          assistantContent.push({
            type: 'text',
            text: `[Subagent ${item.kind}: ${item.agentPath} (${item.agentThreadId})]`,
          });
          break;
        case 'imageView':
          assistantItemIds.push(item.id);
          assistantContent.push({ type: 'text', text: `[Viewed image: ${item.path}]` });
          break;
      }
    }
    if (pendingUserContent.length > 0 || pendingContextBlocks.length > 0) flushPendingUser(turn.startedAt);
    flushAssistant();
    return { messages, messagePartProvenance, userBoundaries, assistantBoundaries };
  }

  private async projectCompaction(
    item: ContextCompactionThreadItem,
    sourceTurns: readonly Turn[],
  ): Promise<ProjectedContextPart[]> {
    const content: ProjectedContextPart[] = [];
    const renderedDegradations = new Set<string>();
    const pushDegradation = (
      kind: ContextPayloadKind,
      degradation: ContextDegradationCheckpointEntry,
    ) => {
      const key = JSON.stringify([degradation.code, degradation.source, degradation.reference]);
      if (renderedDegradations.has(key)) return;
      renderedDegradations.add(key);
      content.push(this.degradationPart(kind, degradation));
    };
    const summary = await this.readCompactionPayload(
      item,
      item.summaryRef,
      'compactionSummary',
    ).catch(() => null);
    if (summary) {
      content.push(contextBlock(
        'compactionSummary',
        `source=${summary.source}\nlossy_derived_context=true\n${summary.text}`,
        'untrusted',
        'observation',
      ));
    } else {
      pushDegradation(
        'compactionSummary',
        contextDegradation('payloadUnavailable', 'compactionSummary', item.summaryRef.id),
      );
    }
    const restored = await this.readCompactionPayload(
      item,
      item.restoredStateRef,
      'compactionRestoredState',
    ).catch(() => null);
    if (!restored) {
      pushDegradation(
        'compactionRestoredState',
        contextDegradation('payloadUnavailable', 'compactionRestoredState', item.restoredStateRef.id),
      );
      return content;
    }
    for (const degradation of restored.degradations) {
      pushDegradation('compactionRestoredState', degradation);
    }

    const skillCatalog = await restoreSkillCatalogCheckpoint(
      sourceTurns,
      item.coveredThrough,
      restored,
      this.resources.readContext,
    );
    for (const degradation of skillCatalog.degradations) {
      pushDegradation('skillCatalog', degradation);
    }
    if (skillCatalog.catalogHash) {
      content.push(contextBlock('skillCatalog', renderSkillCatalog({
        schemaVersion: 1,
        kind: 'skillCatalog',
        mode: 'baseline',
        previousCatalogHash: null,
        catalogHash: skillCatalog.catalogHash,
        entries: [...skillCatalog.catalogEntries.values()],
      }), 'application', 'instruction', ['restored_after_compaction=true']));
    }

    const roleCatalog = await restoreRoleCatalogCheckpoint(
      sourceTurns,
      item.coveredThrough,
      restored,
      this.resources.readContext,
    );
    for (const degradation of roleCatalog.degradations) {
      pushDegradation('roleCatalog', degradation);
    }
    if (roleCatalog.catalogHash) {
      content.push(contextBlock('roleCatalog', renderRoleCatalog({
        schemaVersion: 1,
        kind: 'roleCatalog',
        mode: 'baseline',
        previousCatalogHash: null,
        catalogHash: roleCatalog.catalogHash,
        entries: [...roleCatalog.catalogEntries.values()],
      }), 'application', 'instruction', ['restored_after_compaction=true']));
    }

    if (restored.userViewBaselineRef) {
      const baseline = await this.readCompactionPayload(
        item,
        restored.userViewBaselineRef,
        'userView',
      ).catch(() => null);
      const rendered = baseline ? renderUserView(null, baseline) : null;
      if (!baseline || !rendered?.application) {
        pushDegradation(
          'userView',
          contextDegradation('payloadUnavailable', 'userView', restored.userViewBaselineRef.id),
        );
      } else {
        content.push(contextBlock('userView', rendered.application, 'application', 'observation', [
          'restored_after_compaction=true',
        ]));
        if (rendered.untrusted) {
          content.push(contextBlock('userView', rendered.untrusted, 'untrusted', 'observation', [
            'restored_after_compaction=true',
          ]));
        }
        this.previousUserView = baseline;
      }
    }
    if (restored.additionalContextBaselineRef) {
      const baseline = await this.readCompactionPayload(
        item,
        restored.additionalContextBaselineRef,
        'additionalContext',
      ).catch(() => null);
      if (!baseline || baseline.threadState === null) {
        pushDegradation(
          'additionalContext',
          contextDegradation(
            baseline ? 'checkpointMismatch' : 'payloadUnavailable',
            'additionalContext',
            restored.additionalContextBaselineRef.id,
          ),
        );
      } else {
        content.push(...this.projectAdditionalThreadState(
          baseline.threadState,
          ['restored_after_compaction=true'],
        ));
      }
    }
    for (const checkpoint of restored.activeSkills) {
      const skill = await this.readCompactionPayload(
        item,
        checkpoint.payloadRef,
        'skillInvocation',
      ).catch(() => null);
      if (
        !skill
        || skill.execution !== 'inline'
        || skill.name !== checkpoint.name
        || skill.identity !== checkpoint.identity
        || skill.contentHash !== checkpoint.contentHash
      ) {
        pushDegradation(
          'skillInvocation',
          contextDegradation(
            skill ? 'checkpointMismatch' : 'payloadUnavailable',
            'skillInvocation',
            checkpoint.payloadRef.id,
          ),
        );
        continue;
      }
      content.push(contextBlock('skillInvocation', skill.instructions, 'application', 'instruction', [
        `name=${skill.name}`,
        'restored_after_compaction=true',
      ]));
    }
    for (const observation of restored.activeObservations) {
      const projection = await this.readCompactionPayload(
        item,
        observation.projectionRef,
        'toolOutputProjection',
      ).catch(() => null);
      if (!projection || !outputReferencesEqual(projection.outputRef, observation.outputRef)) {
        pushDegradation(
          'toolOutputProjection',
          contextDegradation(
            projection ? 'checkpointMismatch' : 'payloadUnavailable',
            'toolOutputProjection',
            observation.projectionRef.id,
          ),
        );
        continue;
      }
      const text = await projectedToolOutputText(projection, this.resources).catch(() => null);
      if (text === null) {
        pushDegradation(
          'toolOutputProjection',
          contextDegradation('payloadUnavailable', 'toolOutput', observation.outputRef.id),
        );
        continue;
      }
      content.push(contextBlock('toolOutputProjection', [
        `tool=${observation.tool}`,
        `subject=${observation.subject}`,
        `output_ref=${observation.outputRef.id}`,
        'historical_snapshot=true',
        'Read the current source again before relying on it if it may have changed.',
        text,
      ].join('\n'), 'untrusted', 'observation'));
    }
    if (item.instructionsRef) {
      const instructions = await this.readCompactionPayload(
        item,
        item.instructionsRef,
        'compactionInstructions',
      ).catch(() => null);
      if (!instructions) {
        pushDegradation(
          'compactionInstructions',
          contextDegradation('payloadUnavailable', 'compactionInstructions', item.instructionsRef.id),
        );
        return content;
      }
      for (const entry of instructions.entries) {
        content.push(contextBlock(
          instructions.kind,
          entry.text,
          entry.authority,
          entry.purpose,
          [`key=${entry.key}`, `source=${entry.source}`],
        ));
      }
    }
    return content;
  }

  private async readCompactionPayload<K extends ThreadContextPayload['kind']>(
    item: ContextCompactionThreadItem,
    ref: ThreadContextPayloadReference,
    kind: K,
  ): Promise<Extract<ThreadContextPayload, { readonly kind: K }>> {
    const cached = this.payloads.get(ref.id);
    const payload = cached ?? await this.resources.readContext(ref);
    if (!payload || payload.kind !== kind) {
      throw new Error(`Compaction context is unavailable or corrupt: ${kind}/${ref.id}`);
    }
    assertContextPayloadDependencies(item, payload);
    this.payloads.set(ref.id, payload);
    return payload as Extract<ThreadContextPayload, { readonly kind: K }>;
  }

  private degradationPart(
    kind: ContextPayloadKind,
    degradation: ContextDegradationCheckpointEntry,
  ): ProjectedContextBlock {
    return contextBlock(
      kind,
      renderContextDegradation(degradation),
      'application',
      'observation',
      ['degraded_context=true'],
    );
  }

  private async projectEvidence(
    item: ContextEvidenceThreadItem,
  ): Promise<ProjectedContextPart[]> {
    const payload = await this.readEvidencePayload(item);
    switch (payload.kind) {
      case 'turnEnvironment':
      {
        const rendered = renderEnvironment(this.previousEnvironment, payload);
        this.previousEnvironment = payload;
        return [
          ...(rendered.application
            ? [contextBlock(payload.kind, rendered.application, 'application', 'observation')]
            : []),
          ...(rendered.untrusted
            ? [contextBlock(payload.kind, rendered.untrusted, 'untrusted', 'observation')]
            : []),
        ];
      }
      case 'userView': {
        const rendered = renderUserView(this.previousUserView, payload);
        this.previousUserView = payload;
        return [
          ...(rendered.application
            ? [contextBlock(payload.kind, rendered.application, 'application', 'observation')]
            : []),
          ...(rendered.untrusted
            ? [contextBlock(payload.kind, rendered.untrusted, 'untrusted', 'observation')]
            : []),
        ];
      }
      case 'additionalContext':
        return this.projectAdditionalContext(payload);
      case 'referencedResources':
        return this.projectReferencedResources(payload);
      case 'skillCatalog':
        return [contextBlock(payload.kind, renderSkillCatalog(payload), 'application', 'instruction')];
      case 'skillInvocation':
        return [
          contextBlock(payload.kind, [
            `name=${payload.name}`,
            payload.displayName !== payload.name ? `display_name=${payload.displayName}` : null,
            `execution=${payload.execution}`,
            `allowed_tools=${payload.constraints.allowedTools.join(',') || 'none'}`,
            `model=${payload.constraints.model ?? 'inherit'}`,
            `effort=${payload.constraints.effort ?? 'inherit'}`,
          ].filter((line): line is string => line !== null).join('\n'), 'application', 'observation'),
          ...(payload.execution === 'inline'
            ? [contextBlock(payload.kind, payload.instructions, 'application', 'instruction')]
            : []),
          ...(payload.arguments
            ? [contextBlock(payload.kind, payload.arguments, 'untrusted', 'observation', ['field=arguments'])]
            : []),
        ];
      case 'roleCatalog':
        return [contextBlock(payload.kind, renderRoleCatalog(payload), 'application', 'instruction')];
      case 'toolOutputProjection':
        return [];
      case 'inheritedContext':
        return [];
    }
  }

  private projectAdditionalContext(
    payload: Extract<ThreadContextPayload, { readonly kind: 'additionalContext' }>,
  ): ProjectedContextBlock[] {
    const content = payload.turnEntries.map((entry) => contextBlock(
      payload.kind,
      entry.text,
      entry.authority,
      entry.purpose,
      [`key=${entry.key}`, `source=${entry.source}`, 'lifetime=turn'],
    ));
    if (payload.threadState === null) return content;

    content.push(...this.projectAdditionalThreadState(payload.threadState));
    return content;
  }

  private projectAdditionalThreadState(
    threadState: readonly ContextTextEntry[],
    metadata: readonly string[] = [],
  ): ProjectedContextBlock[] {
    const content: ProjectedContextBlock[] = [];
    const next = new Map(threadState.map((entry) => [entry.key, entry]));
    for (const entry of threadState) {
      const previous = this.previousAdditionalContext?.get(entry.key);
      if (previous && contextEntriesEqual(previous, entry)) continue;
      content.push(contextBlock(
        'additionalContext',
        entry.text,
        entry.authority,
        entry.purpose,
        [`key=${entry.key}`, `source=${entry.source}`, 'lifetime=thread', 'state=set', ...metadata],
      ));
    }
    if (this.previousAdditionalContext) {
      for (const entry of this.previousAdditionalContext.values()) {
        if (next.has(entry.key)) continue;
        content.push(contextBlock(
          'additionalContext',
          'state=cleared',
          'application',
          'observation',
          [`key=${entry.key}`, `source=${entry.source}`, 'lifetime=thread', ...metadata],
        ));
      }
    }
    this.previousAdditionalContext = next;
    return content;
  }

  private async readEvidencePayload(
    item: ContextEvidenceThreadItem,
  ): Promise<Extract<ThreadContextPayload, { readonly kind: ContextEvidenceThreadItem['kind'] }>> {
    const cached = this.payloads.get(item.payloadRef.id);
    const payload = cached ?? await this.resources.readContext(item.payloadRef);
    if (!payload || payload.kind !== item.kind) {
      throw new Error(`Context evidence is unavailable or corrupt: ${item.kind}/${item.payloadRef.id}`);
    }
    assertContextPayloadDependencies(item, payload);
    this.payloads.set(item.payloadRef.id, payload);
    return payload as Extract<ThreadContextPayload, { readonly kind: ContextEvidenceThreadItem['kind'] }>;
  }

  private async projectReferencedResources(
    payload: ReferencedResourcesContextPayload,
  ): Promise<ProjectedContextPart[]> {
    const content: ProjectedContextPart[] = [];
    for (const resource of payload.resources) {
      let path: string | null = null;
      if (resource.resourceRef) {
        path = await this.resources.resolveResourceObservationPath(resource.resourceRef);
        if (!path) {
          content.push(this.degradationPart(
            'referencedResources',
            contextDegradation('payloadUnavailable', 'referencedResource', resource.resourceRef.id),
          ));
        }
      }
      content.push(contextBlock('referencedResources', [
        `node_id=${resource.nodeId}`,
        `node_type=${resource.nodeType}`,
        `availability=${resource.unavailableReason ?? (path ? 'available' : resource.resourceRef ? 'missing' : 'identity-only')}`,
        path ? `readable_path=${path}` : null,
        resource.contentTruncated ? 'snapshot_content_truncated=true' : null,
      ].filter((line): line is string => line !== null).join('\n'), 'application', 'observation'));
      content.push(contextBlock('referencedResources', [
        `node_id=${resource.nodeId}`,
        `title=${resource.title}`,
        `breadcrumb=${resource.breadcrumb.map((node) => `${node.title} (${node.nodeId})`).join(' / ') || 'none'}`,
        path && resource.resourceRef
          ? `file_reference=${formatFileReferenceMarker(
              resource.title || resource.resourceRef.fileName,
              path,
              resource.resourceRef.mimeType === 'inode/directory' ? 'directory' : 'file',
            )}`
          : null,
        resource.content ? `snapshot_content:\n${resource.content}` : null,
      ].filter((line): line is string => line !== null).join('\n'), 'untrusted', 'observation'));
      if (resource.inlineImage && resource.resourceRef) {
        const bytes = await this.resources.readResource(resource.resourceRef).catch(() => null);
        if (!bytes) {
          content.push(this.degradationPart(
            'referencedResources',
            contextDegradation('payloadUnavailable', 'referencedImage', resource.resourceRef.id),
          ));
          continue;
        }
        content.push({
          type: 'contextImage',
          content: { type: 'image', data: bytes.toString('base64'), mimeType: resource.resourceRef.mimeType },
          entry: { kind: 'referencedResources', authority: 'untrusted', purpose: 'observation' },
        });
      }
    }
    return content;
  }
}

export async function serializeUserContent(
  content: readonly ThreadUserContent[],
  resources: Pick<
    ProjectionResources,
    'readResource' | 'resolveResourceObservationPath' | 'resolveImageArtifactPath'
  >,
): Promise<Array<TextContent | ImageContent>> {
  try {
    assertCanonicalUserContent(content);
  } catch (error) {
    console.warn('[agent] Projecting degraded canonical user content', error);
  }
  const attachments: Array<{
    readonly part: Extract<ThreadUserContent, { readonly type: 'attachment' }>;
    readonly location: string | null;
  }> = [];
  const narrative: string[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        narrative.push(part.text);
        break;
      case 'nodeReference':
        narrative.push(formatNodeReferenceMarker(part.note ?? part.nodeId, part.nodeId));
        break;
      case 'attachment': {
        const location = part.artifactRef
          ? await resolveImageArtifactPathForProjection(
              resources,
              part.artifactRef,
              'user-attachment',
            )
          : part.source.kind === 'localFile'
            ? part.source.path
            : await resources.resolveResourceObservationPath(part.source.ref).catch(() => null);
        if (!location) {
          narrative.push(part.artifactRef
            ? `[Image attachment: ${part.name}; readable path unavailable]`
            : `[Attachment unavailable: ${part.name}]`);
          if (!part.artifactRef) break;
        } else {
          narrative.push(formatFileReferenceMarker(
            part.name,
            location,
            part.mimeType === 'inode/directory' ? 'directory' : 'file',
          ));
        }
        attachments.push({ part, location });
        break;
      }
    }
  }

  const converted: Array<TextContent | ImageContent> = [];
  const impliedPrompt = impliedUserPrompt(content);
  if (impliedPrompt) converted.push({ type: 'text', text: impliedPrompt });
  const narrativeText = narrative.join('');
  if (narrativeText) converted.push({ type: 'text', text: narrativeText });

  for (const { part, location } of attachments) {
    if (part.mimeType.startsWith('image/')) {
      const artifact = part.artifactRef;
      if (!artifact) {
        converted.push({ type: 'text', text: `[Attachment image artifact unavailable or corrupt: ${part.name}]` });
        continue;
      }
      const image = await resources.readResource(artifact.observation).catch(() => null);
      if (!image) {
        converted.push({
          type: 'text',
          text: `[Attachment image unavailable or corrupt: ${part.name}; artifact=${artifact.id}]`,
        });
        continue;
      }
      converted.push({
        type: 'text',
        text: [
          `[Attachment image: ${part.name}, ${part.mimeType}, ${part.sizeBytes} bytes]`,
          `Artifact: ${artifact.id}`,
          ...(location ? [`Readable path: ${location}`] : []),
          imageArtifactGeometryText(artifact),
          'The following image is the immutable model observation for this attachment.',
        ].join('\n'),
      });
      converted.push({
        type: 'image',
        data: image.toString('base64'),
        mimeType: artifact.observation.mimeType,
      });
      continue;
    }
    converted.push({
      type: 'text',
      text: [
        `[Attachment: ${part.name}, ${part.mimeType}, ${part.sizeBytes} bytes]`,
        `Readable path: ${location}`,
        part.mimeType === 'inode/directory'
          ? 'Use file_glob with this path to inspect the directory.'
          : 'Use file_read with this path to inspect the attachment.',
        part.extractedText ?? null,
      ].filter((line): line is string => line !== null).join('\n'),
    });
  }
  return converted;
}

function impliedUserPrompt(content: readonly ThreadUserContent[]): string | null {
  if (content.some((part) => part.type === 'text' && part.text.trim())) return null;
  const hasImage = content.some((part) => part.type === 'attachment' && part.mimeType.startsWith('image/'));
  const hasFile = content.some((part) => part.type === 'attachment' && !part.mimeType.startsWith('image/'));
  const hasNode = content.some((part) => part.type === 'nodeReference');
  const subjects = [
    hasFile ? 'attached files' : null,
    hasImage ? 'attached images' : null,
    hasNode ? 'referenced Outliner Nodes' : null,
  ].filter((subject): subject is string => subject !== null);
  if (subjects.length === 0) return null;
  const joined = subjects.length === 1
    ? subjects[0]
    : `${subjects.slice(0, -1).join(', ')} and ${subjects.at(-1)}`;
  return `Please review the ${joined}.`;
}

function contextBlock(
  kind: ContextPayloadKind,
  body: string,
  authority: ContextAuthority,
  purpose: ContextPurpose,
  metadata: readonly string[] = [],
): ProjectedContextBlock {
  return {
    type: 'contextBlock',
    kind,
    authority,
    purpose,
    body,
    metadata,
  };
}

function contextBundle(blocks: readonly ProjectedContextBlock[]): TextContent {
  return {
    type: 'text',
    text: [
      '<system-reminder>',
      ...blocks.flatMap((block) => [
        `<context-evidence kind="${escapeXml(block.kind)}" authority="${block.authority}" purpose="${block.purpose}">`,
        ...block.metadata.map((entry) => `  <meta>${escapeXml(entry)}</meta>`),
        escapeXml(block.body),
        '</context-evidence>',
      ]),
      '</system-reminder>',
    ].join('\n'),
  };
}

function systemContextProvenance(
  blocks: readonly ProjectedContextBlock[],
): TurnDiagnosticsMessagePartProvenance {
  return {
    source: 'systemContext',
    entries: blocks.map(({ kind, authority, purpose }) => ({ kind, authority, purpose })),
  };
}

function renderUserView(
  previous: UserViewContextPayload | null,
  next: UserViewContextPayload,
): { readonly application: string | null; readonly untrusted: string | null } {
  if (previous && JSON.stringify(previous) === JSON.stringify(next)) {
    return { application: null, untrusted: null };
  }
  const application = [`projection_mode=${previous ? 'delta' : 'snapshot'}`];
  if (!previous || previous.mode !== next.mode) application.push(`interaction_mode=${next.mode}`);
  const observation: string[] = [];
  const labels = new Map<string, string>();
  const recordLabel = (node: { readonly nodeId: string; readonly title: string }) => labels.set(node.nodeId, node.title);
  if (!previous || previous.activePanelId !== next.activePanelId) {
    observation.push(`active_panel_id=${next.activePanelId ?? 'none'}`);
  }
  if (!previous || previous.focusedPanelId !== next.focusedPanelId) {
    observation.push(`focused_panel_id=${next.focusedPanelId ?? 'none'}`);
  }
  if (!previous || !sameJson(previous.focusedNode, next.focusedNode)) {
    observation.push(`focused_node_id=${next.focusedNode?.nodeId ?? 'none'}`);
    if (next.focusedNode) recordLabel(next.focusedNode);
  }
  if (!previous || previous.focusSurface !== next.focusSurface) {
    observation.push(`focus_surface=${next.focusSurface ?? 'none'}`);
  }
  if (!previous || !sameJson(previous.referencedNodes, next.referencedNodes)) {
    observation.push(`explicit_reference_ids=${next.referencedNodes.map((node) => node.nodeId).join(',') || 'none'}`);
    next.referencedNodes.forEach(recordLabel);
  }
  if (!previous || !sameJson(previous.selectedNodes, next.selectedNodes)) {
    observation.push(`selected_node_ids=${next.selectedNodes.map((node) => node.nodeId).join(',') || 'none'}`);
    next.selectedNodes.forEach(recordLabel);
  }
  if (!previous || previous.truncated !== next.truncated) {
    observation.push(`snapshot_truncated=${next.truncated}`);
  }
  const previousPanels = new Map(previous?.panels.map((panel) => [panel.panelId, panel]) ?? []);
  for (const panel of next.panels) {
    const before = previousPanels.get(panel.panelId);
    if (previous && before && JSON.stringify(before) === JSON.stringify(panel)) continue;
    observation.push([
      `panel=${panel.panelId}`,
      `root_node_id=${panel.rootNodeId}`,
      `root_type=${panel.rootType}`,
      `order=${panel.order}`,
      `active=${panel.active}`,
      `focused=${panel.focused}`,
      `child_count=${panel.childCount}`,
    ].join(' '));
    recordLabel({ nodeId: panel.rootNodeId, title: panel.rootTitle });
    for (const node of panel.breadcrumb) {
      observation.push(`breadcrumb_node_id=${node.nodeId}`);
      recordLabel(node);
    }
    for (const node of panel.visibleOutline) {
      observation.push([
        `visible_node_id=${node.nodeId}`,
        `depth=${node.depth}`,
        `focused=${node.focused}`,
        `collapsed=${node.collapsed}`,
        `child_count=${node.childCount}`,
        `included_child_count=${node.includedChildCount ?? 'unknown'}`,
      ].join(' '));
      recordLabel(node);
    }
    if (panel.visibleOutlineTruncated) observation.push(`visible_outline_truncated=${panel.panelId}`);
  }
  if (previous) {
    for (const panel of previous.panels) {
      if (!next.panels.some((candidate) => candidate.panelId === panel.panelId)) {
        observation.push(`panel_closed=${panel.panelId} root_node_id=${panel.rootNodeId}`);
      }
    }
  }
  observation.push(...[...labels]
    .sort(([left], [right]) => compareStableText(left, right))
    .map(([nodeId, title]) => `node_id=${nodeId} title=${title}`));
  return {
    application: application.join('\n'),
    untrusted: observation.join('\n') || null,
  };
}

function renderEnvironment(
  previous: TurnEnvironmentContextPayload | null,
  next: TurnEnvironmentContextPayload,
): { readonly application: string | null; readonly untrusted: string | null } {
  const lines = [`projection_mode=${previous ? 'delta' : 'snapshot'}`];
  const fields = [
    ['utcInstant', 'accepted_at', next.utcInstant],
    ['localDate', 'local_date', next.localDate],
    ['localTime', 'local_time', next.localTime],
    ['timeZone', 'timezone', next.timeZone],
    ['utcOffsetMinutes', 'utc_offset_minutes', String(next.utcOffsetMinutes)],
    ['locale', 'locale', next.locale],
    ['workingDirectory', 'working_directory', next.workingDirectory],
    ['conversationMode', 'conversation_mode', next.conversationMode],
    ['executionMode', 'execution_mode', next.executionMode],
    ['replyIdentity', 'reply_identity', next.replyIdentity ?? 'none'],
    ['todayNodeId', 'today_node_id', next.todayNodeId ?? 'none'],
  ] as const;
  for (const [property, label, value] of fields) {
    if (!previous || previous[property] !== next[property]) lines.push(`${label}=${value}`);
  }
  const untrusted = !previous || previous.todayNodeTitle !== next.todayNodeTitle
    ? [
        `projection_mode=${previous ? 'delta' : 'snapshot'}`,
        `today_node_title=${next.todayNodeTitle ?? 'none'}`,
      ].join('\n')
    : null;
  return {
    application: lines.length > 1 ? lines.join('\n') : null,
    untrusted,
  };
}

function contextEntriesEqual(left: ContextTextEntry, right: ContextTextEntry): boolean {
  return left.key === right.key
    && left.source === right.source
    && left.authority === right.authority
    && left.purpose === right.purpose
    && left.text === right.text;
}

function outputReferencesEqual(
  left: ToolOutputProjectionContextPayload['outputRef'],
  right: ToolOutputProjectionContextPayload['outputRef'],
): boolean {
  return outputReferenceKey(left) === outputReferenceKey(right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderSkillCatalog(payload: SkillCatalogContextPayload): string {
  return [
    `mode=${payload.mode}`,
    ...payload.entries.map((entry) => [
      `- name=${entry.name}`,
      payload.mode === 'delta' ? `change=${entry.change}` : null,
      entry.displayName !== entry.name ? `display_name=${entry.displayName}` : null,
      `description=${entry.description}`,
    ].filter((value): value is string => value !== null).join(' ')),
    'Use the skill tool to load a matching Skill before responding to a task it covers.',
  ].join('\n');
}

function renderRoleCatalog(payload: RoleCatalogContextPayload): string {
  return [
    `mode=${payload.mode}`,
    ...payload.entries.map((entry) => [
      `- name=${entry.name}`,
      payload.mode === 'delta' ? `change=${entry.change}` : null,
      entry.displayName !== entry.name ? `display_name=${entry.displayName}` : null,
      `description=${entry.description}`,
    ].filter((value): value is string => value !== null).join(' ')),
    'Pass a matching Agent type as subagent_type when calling agent.',
  ].join('\n');
}

function assistantHistoryMessage(
  content: AssistantMessage['content'],
  timestamp: number,
  model: Model<Api>,
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

export type HistoryToolItem = Extract<ThreadItem, {
  type: 'commandExecution' | 'fileChange' | 'mcpToolCall' | 'dynamicToolCall' | 'collabAgentToolCall' | 'webSearch';
}>;
type DynamicToolImageContent = Extract<
  NonNullable<Extract<ThreadItem, { type: 'dynamicToolCall' }>['contentItems']>[number],
  { type: 'image' }
>;

function isToolItem(item: ThreadItem): item is HistoryToolItem {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch';
}

async function historyTool(
  item: HistoryToolItem,
  timestamp: number,
  resources: Pick<
    ProjectionResources,
    'readContext' | 'readOutput' | 'readResource' | 'resolveImageArtifactPath'
  >,
  projection: ToolOutputProjectionContextPayload | null,
  projectionUnavailable: boolean,
  liveCall: LiveModelToolCall | null,
): Promise<
  | { readonly kind: 'exchange'; readonly marker: TextContent | null; readonly call: ToolCall; readonly result: ToolResultMessage }
  | { readonly kind: 'evidence'; readonly text: string }
> {
  let args: JsonValue;
  let providerName: string;
  if (liveCall) {
    args = liveCall.arguments;
    providerName = liveCall.providerName;
  } else {
    const stored = item.modelCall;
    if (stored.disposition === 'evidenceOnly') {
      return { kind: 'evidence', text: await historicalToolEvidence(item, stored.reason) };
    }
    const source = modelCallArgumentSource(stored);
    providerName = stored.providerName;
    if (source.storage === 'inline') {
      args = source.value;
    } else {
      const payload = await resources.readContext(source.ref).catch(() => null);
      if (!payload || payload.kind !== 'toolCallArguments') {
        return { kind: 'evidence', text: await historicalToolEvidence(item, 'argumentPayloadUnavailable') };
      }
      args = payload.value;
    }
  }
  if (projectionUnavailable) {
    return { kind: 'evidence', text: await historicalToolEvidence(item, 'resultPayloadUnavailable') };
  }
  let resultContent: Array<TextContent | ImageContent>;
  try {
    resultContent = await historyToolResultContent(item, resources, projection);
  } catch {
    return { kind: 'evidence', text: await historicalToolEvidence(item, 'resultPayloadUnavailable') };
  }
  const marker = !liveCall && item.modelCall.disposition === 'redactedReplay'
    ? { type: 'text' as const, text: redactedReplayMarker(item.id, item.modelCall.redactedPaths) }
    : null;
  return {
    kind: 'exchange',
    marker,
    call: { type: 'toolCall', id: item.id, name: providerName, arguments: args as Record<string, any> },
    result: {
      role: 'toolResult',
      toolCallId: item.id,
      toolName: providerName,
      content: resultContent,
      isError: item.status !== 'completed',
      timestamp,
    },
  };
}

async function historicalToolEvidence(
  item: HistoryToolItem,
  reason: import('../../../core/agent/protocol').ModelToolCallEvidenceReason,
): Promise<string> {
  const stored = item.modelCall;
  const identity = stored.identity;
  const identityValue: JsonValue = identity
    ? { namespace: identity.namespace, name: identity.name }
    : null;
  const argumentSummary = stored.disposition === 'evidenceOnly'
    ? stored.redactedArgumentsSummary
    : (() => {
      const source = modelCallArgumentSource(stored);
      return source.storage === 'inline'
          ? source.value
          : { unavailablePayloadRef: source.ref.id };
      })();
  const correction = stored.disposition === 'evidenceOnly'
    ? stored.correction
    : evidenceCorrection(reason);
  const evidence = (await redactSecretLikeJsonAsync({
    callId: item.id,
    identity: identityValue,
    providerName: stored.providerName,
    reason,
    redactedArgumentsSummary: argumentSummary,
    outcome: {
      status: item.status,
      visibleOutput: reason === 'resultPayloadUnavailable'
        ? { unavailable: 'frozen tool-result projection' }
        : toolItemVisibleOutputText(item),
    },
    correction,
  })).value;
  return `[Historical tool-call evidence: ${JSON.stringify({
    callId: boundedRedactedJsonSummary(evidence.callId, 2 * 1024),
    identity: boundedRedactedJsonSummary(evidence.identity, 2 * 1024),
    providerName: evidence.providerName,
    reason: evidence.reason,
    redactedArgumentsSummary: boundedRedactedJsonSummary(evidence.redactedArgumentsSummary, 8 * 1024),
    outcome: {
      status: evidence.outcome.status,
      visibleOutput: boundedRedactedJsonSummary(evidence.outcome.visibleOutput, 8 * 1024),
    },
    correction: evidence.correction,
  })}]`;
}

async function historyToolResultContent(
  item: HistoryToolItem,
  resources: Pick<ProjectionResources, 'readOutput' | 'readResource' | 'resolveImageArtifactPath'>,
  projection: ToolOutputProjectionContextPayload | null,
): Promise<Array<TextContent | ImageContent>> {
  const projectedText = await projectedToolOutputText(projection, resources);
  if (item.type === 'dynamicToolCall') {
    const content: Array<TextContent | ImageContent> = [];
    if (projectedText !== null) content.push({ type: 'text', text: projectedText });
    for (const part of item.contentItems ?? []) {
      if (part.type === 'text') {
        if (projectedText === null) content.push({ type: 'text', text: part.text });
      } else if (part.type === 'json') {
        if (projectedText === null) content.push({ type: 'text', text: JSON.stringify(part.value) });
      } else {
        const artifact = part.artifactRef;
        const bytes = await resources.readResource(artifact.observation);
        if (!bytes) {
          content.push({ type: 'text', text: dynamicToolImageUnavailableIdentity(part) });
          continue;
        }
        const readablePath = await resolveImageArtifactPathForProjection(
          resources,
          artifact,
          'tool-history',
        );
        content.push({ type: 'text', text: dynamicToolImageIdentity(part, readablePath) });
        content.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: artifact.observation.mimeType,
        });
      }
    }
    if (content.length > 0) return content;
  }
  return [{ type: 'text', text: projectedText ?? toolItemVisibleOutputText(item) }];
}

async function projectedToolOutputText(
  payload: ToolOutputProjectionContextPayload | null,
  resources: Pick<ProjectionResources, 'readOutput'>,
): Promise<string | null> {
  if (!payload) return null;
  if (payload.projection.type !== 'full') return payload.projection.text;
  const text = await resources.readOutput(payload.outputRef);
  if (text === null) throw new Error(`Full tool output is unavailable or corrupt: ${payload.outputRef.id}`);
  return text;
}

export function dynamicToolImageIdentity(
  part: DynamicToolImageContent,
  readablePath: string | null = null,
): string {
  const label = dynamicToolImageLabel(part);
  const artifact = part.artifactRef;
  return [
    `[Image output: ${label}, artifact=${artifact.id}, ${artifact.observation.mimeType}, ${artifact.observation.byteLength} observation bytes]`,
    ...(readablePath ? [`Readable path: ${readablePath}`] : []),
    imageArtifactGeometryText(artifact),
  ].join('\n');
}

function dynamicToolImageUnavailableIdentity(
  part: DynamicToolImageContent,
): string {
  const artifact = part.artifactRef;
  return `[Image output unavailable or corrupt: ${dynamicToolImageLabel(part)}, artifact=${artifact.id}]`;
}

async function resolveImageArtifactPathForProjection(
  resources: Pick<ProjectionResources, 'resolveImageArtifactPath'>,
  artifact: ThreadImageArtifactReference,
  surface: 'user-attachment' | 'tool-history',
): Promise<string | null> {
  try {
    return await resources.resolveImageArtifactPath(artifact);
  } catch (error) {
    console.warn('[agent][context-projection] image artifact path unavailable', {
      artifactId: artifact.id,
      surface,
      error,
    });
    return null;
  }
}

function dynamicToolImageLabel(
  part: DynamicToolImageContent,
): string {
  const source = `artifact:${part.artifactRef.id}`;
  const alt = part.alt?.trim().replace(/\s+/g, ' ');
  return alt && alt !== source ? `${alt} (${source})` : alt || source;
}

function imageArtifactGeometryText(artifact: ThreadImageArtifactReference): string {
  const geometry = artifact.geometry;
  const scaleX = geometry.sourceWidth / geometry.observationWidth;
  const scaleY = geometry.sourceHeight / geometry.observationHeight;
  return [
    `Image geometry: observation=${geometry.observationWidth}x${geometry.observationHeight}; source=${geometry.sourceWidth}x${geometry.sourceHeight}`,
    `Source pixels per observation pixel: x=${formatGeometryNumber(scaleX)}, y=${formatGeometryNumber(scaleY)}`,
    `Observation-to-source matrix: [${geometry.observationToSource.map(formatGeometryNumber).join(', ')}]`,
  ].join('\n');
}

function formatGeometryNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '');
}

export function toolItemVisibleOutputText(item: HistoryToolItem): string {
  switch (item.type) {
    case 'commandExecution': return item.aggregatedOutput ?? JSON.stringify({ status: item.status, exitCode: item.exitCode });
    case 'fileChange': return JSON.stringify({ status: item.status, changes: item.changes });
    case 'mcpToolCall': return item.error ?? JSON.stringify(item.result ?? { status: item.status });
    case 'dynamicToolCall': return JSON.stringify({ status: item.status, success: item.success });
    case 'collabAgentToolCall': return JSON.stringify({
      status: item.status,
      receiverThreadIds: item.receiverThreadIds,
      agentsStates: item.agentsStates,
    });
    case 'webSearch': return item.error ?? JSON.stringify(item.results);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
