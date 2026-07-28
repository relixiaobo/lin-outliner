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
} from '@earendil-works/pi-ai';
import type {
  ContextEvidenceThreadItem,
  ContextCompactionThreadItem,
  ReferencedResourcesContextPayload,
  RoleCatalogContextPayload,
  SkillCatalogContextPayload,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ToolOutputProjectionContextPayload,
  ThreadItem,
  ThreadResourceReference,
  ThreadUserContent,
  Turn,
  UserViewContextPayload,
} from '../../../core/agent/protocol';
import { assertContextPayloadDependencies } from './contextDependencies';
import { selectEffectiveContext } from './ContextEpoch';
import { restoreRoleCatalogCheckpoint } from './RoleContextReducer';
import { restoreSkillCatalogCheckpoint } from './SkillContextReducer';
import { assertCanonicalUserContent } from './userContentIntegrity';

interface ProjectionResources {
  readContext(ref: ContextEvidenceThreadItem['payloadRef']): Promise<ThreadContextPayload | null>;
  readOutput(ref: ToolOutputProjectionContextPayload['outputRef']): Promise<string | null>;
  readResource(ref: ThreadResourceReference): Promise<Buffer | null>;
  resolveResourceObservationPath(ref: ThreadResourceReference): Promise<string | null>;
}

export interface ProjectedTurnBoundary {
  readonly turnId: string;
  readonly messageIndex: number;
}

export interface ProjectedUserBoundary extends ProjectedTurnBoundary {
  readonly itemId: string;
}

export interface CanonicalContextProjection {
  readonly messages: Message[];
  readonly turnBoundaries: readonly ProjectedTurnBoundary[];
  readonly userBoundaries: readonly ProjectedUserBoundary[];
}

export class CanonicalContextProjector {
  private previousUserView: UserViewContextPayload | null = null;
  private readonly payloads = new Map<string, ThreadContextPayload>();
  private readonly toolOutputProjections = new Map<string, ToolOutputProjectionContextPayload>();

  constructor(
    private readonly model: Model<Api>,
    private readonly resources: ProjectionResources,
  ) {}

  async projectTurns(turns: readonly Turn[]): Promise<Message[]> {
    return (await this.projectTurnsWithBoundaries(turns)).messages;
  }

  async projectTurnsWithBoundaries(turns: readonly Turn[]): Promise<CanonicalContextProjection> {
    const selectedTurns = selectEffectiveContext(turns).turns;
    await this.prepareToolOutputProjections(selectedTurns);
    const messages: Message[] = [];
    const turnBoundaries: ProjectedTurnBoundary[] = [];
    const userBoundaries: ProjectedUserBoundary[] = [];
    for (const turn of selectedTurns) {
      const projected = await this.projectTurn(turn, turns);
      if (projected.messages.length === 0) continue;
      turnBoundaries.push({ turnId: turn.id, messageIndex: messages.length });
      userBoundaries.push(...projected.userBoundaries.map((boundary) => ({
        ...boundary,
        messageIndex: messages.length + boundary.messageIndex,
      })));
      messages.push(...projected.messages);
    }
    return { messages, turnBoundaries, userBoundaries };
  }

  private async prepareToolOutputProjections(turns: readonly Turn[]): Promise<void> {
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type !== 'contextEvidence' || item.kind !== 'toolOutputProjection') continue;
        const payload = await this.readEvidencePayload(item);
        if (payload.kind !== 'toolOutputProjection') {
          throw new Error(`Context evidence kind mismatch: ${item.kind}/${item.payloadRef.id}`);
        }
        const existing = this.toolOutputProjections.get(payload.outputRef.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(payload)) {
          throw new Error(`Tool output has conflicting frozen projections: ${payload.outputRef.id}`);
        }
        this.toolOutputProjections.set(payload.outputRef.id, payload);
      }
    }
  }

  async projectUserItems(
    items: readonly ThreadItem[],
    fallbackTimestamp: number,
  ): Promise<UserMessage> {
    const content: Array<TextContent | ImageContent> = [];
    let timestamp = fallbackTimestamp;
    for (const item of items) {
      if (item.type === 'contextEvidence') {
        content.push(...await this.projectEvidence(item));
      } else if (item.type === 'userMessage') {
        timestamp = item.acceptedAt;
        content.push(...await serializeUserContent(item.content, this.resources));
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: 'Continue.' });
    return { role: 'user', content, timestamp };
  }

  private async projectTurn(turn: Turn, sourceTurns: readonly Turn[]): Promise<{
    readonly messages: Message[];
    readonly userBoundaries: ProjectedUserBoundary[];
  }> {
    const messages: Message[] = [];
    const userBoundaries: ProjectedUserBoundary[] = [];
    let pendingUserContent: Array<TextContent | ImageContent> = [];
    let assistantContent: Array<TextContent | ToolCall> = [];
    let toolResults: ToolResultMessage[] = [];
    const flushAssistant = () => {
      if (assistantContent.length > 0) {
        messages.push(assistantHistoryMessage(
          assistantContent,
          turn.startedAt,
          this.model,
          toolResults.length > 0 ? 'toolUse' : 'stop',
        ));
      }
      messages.push(...toolResults);
      assistantContent = [];
      toolResults = [];
    };
    const flushPendingUser = (timestamp: number) => {
      flushAssistant();
      if (pendingUserContent.length === 0) pendingUserContent.push({ type: 'text', text: 'Continue.' });
      const messageIndex = messages.length;
      messages.push({ role: 'user', content: pendingUserContent, timestamp });
      pendingUserContent = [];
      return messageIndex;
    };

    for (const item of turn.items) {
      if (item.type === 'contextEvidence') {
        if (item.kind === 'inheritedContext') {
          if (pendingUserContent.length > 0) flushPendingUser(turn.startedAt);
          else flushAssistant();
          const payload = await this.readEvidencePayload(item);
          if (payload.kind !== 'inheritedContext') {
            throw new Error(`Inherited context kind mismatch: ${item.payloadRef.id}`);
          }
          const inheritedProjector = new CanonicalContextProjector(this.model, this.resources);
          messages.push(...await inheritedProjector.projectTurns(payload.turns));
          continue;
        }
        pendingUserContent.push(...await this.projectEvidence(item));
        continue;
      }
      if (item.type === 'userMessage') {
        pendingUserContent.push(...await serializeUserContent(item.content, this.resources));
        userBoundaries.push({
          turnId: turn.id,
          itemId: item.id,
          messageIndex: flushPendingUser(item.acceptedAt),
        });
        continue;
      }
      if (item.type === 'contextReset') {
        if (toolResults.length > 0) flushAssistant();
        pendingUserContent = [];
        this.previousUserView = null;
        continue;
      }
      if (item.type === 'contextCompaction') {
        pendingUserContent.push(...await this.projectCompaction(item, sourceTurns));
        continue;
      }
      if (pendingUserContent.length > 0) flushPendingUser(turn.startedAt);
      if (isToolItem(item)) {
        const projection = item.outputRef ? this.toolOutputProjections.get(item.outputRef.id) ?? null : null;
        const tool = await historyTool(item, turn.startedAt, this.resources, projection);
        assistantContent.push(tool.call);
        toolResults.push(tool.result);
        continue;
      }
      if (toolResults.length > 0) flushAssistant();
      switch (item.type) {
        case 'agentMessage':
          if (item.text) assistantContent.push({ type: 'text', text: item.text });
          break;
        case 'reasoning':
          if (item.summary.length > 0 || item.content.length > 0) {
            assistantContent.push({
              type: 'text',
              text: `[Reasoning]\n${[...item.summary, ...item.content].join('\n')}`,
            });
          }
          break;
        case 'subAgentActivity':
          assistantContent.push({
            type: 'text',
            text: `[Subagent ${item.kind}: ${item.agentPath} (${item.agentThreadId})]`,
          });
          break;
        case 'imageView':
          assistantContent.push({ type: 'text', text: `[Viewed image: ${item.path}]` });
          break;
      }
    }
    if (pendingUserContent.length > 0) flushPendingUser(turn.startedAt);
    flushAssistant();
    return { messages, userBoundaries };
  }

  private async projectCompaction(
    item: ContextCompactionThreadItem,
    sourceTurns: readonly Turn[],
  ): Promise<Array<TextContent | ImageContent>> {
    const summary = await this.readCompactionPayload(item, item.summaryRef, 'compactionSummary');
    const restored = await this.readCompactionPayload(item, item.restoredStateRef, 'compactionRestoredState');
    const content: Array<TextContent | ImageContent> = [textEvidence(
      'compactionSummary',
      `source=${summary.source}\nlossy_derived_context=true\n${summary.text}`,
      'untrusted',
      'observation',
    )];
    content.push(textEvidence('compactionRestoredState', [
      `skill_catalog_hash=${restored.skillCatalogHash ?? 'none'}`,
      `role_catalog_hash=${restored.roleCatalogHash ?? 'none'}`,
      `active_skill_count=${restored.activeSkills.length}`,
      `active_observation_count=${restored.activeObservations.length}`,
    ].join('\n'), 'application', 'observation'));

    const skillCatalog = await restoreSkillCatalogCheckpoint(
      sourceTurns,
      item.coveredThrough,
      restored,
      this.resources.readContext,
    );
    if (skillCatalog.catalogHash) {
      content.push(textEvidence('skillCatalog', renderSkillCatalog({
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
    if (roleCatalog.catalogHash) {
      content.push(textEvidence('roleCatalog', renderRoleCatalog({
        schemaVersion: 1,
        kind: 'roleCatalog',
        mode: 'baseline',
        previousCatalogHash: null,
        catalogHash: roleCatalog.catalogHash,
        entries: [...roleCatalog.catalogEntries.values()],
      }), 'application', 'instruction', ['restored_after_compaction=true']));
    }

    if (restored.userViewBaselineRef) {
      const baseline = await this.readCompactionPayload(item, restored.userViewBaselineRef, 'userView');
      const rendered = renderUserView(null, baseline);
      content.push(textEvidence('userView', rendered.application, 'application', 'observation', [
        'restored_after_compaction=true',
      ]));
      if (rendered.untrusted) {
        content.push(textEvidence('userView', rendered.untrusted, 'untrusted', 'observation', [
          'restored_after_compaction=true',
        ]));
      }
      this.previousUserView = baseline;
    }
    for (const checkpoint of restored.activeSkills) {
      const skill = await this.readCompactionPayload(item, checkpoint.payloadRef, 'skillInvocation');
      content.push(textEvidence('skillInvocation', skill.instructions, 'application', 'instruction', [
        `name=${skill.name}`,
        `identity=${skill.identity}`,
        `content_hash=${skill.contentHash}`,
        'restored_after_compaction=true',
      ]));
    }
    for (const observation of restored.activeObservations) {
      const projection = await this.readCompactionPayload(item, observation.projectionRef, 'toolOutputProjection');
      const text = await projectedToolOutputText(projection, this.resources);
      content.push(textEvidence('toolOutputProjection', [
        `tool=${observation.tool}`,
        `subject=${observation.subject}`,
        `output_ref=${observation.outputRef.id}`,
        'historical_snapshot=true',
        'Read the current source again before relying on it if it may have changed.',
        text,
      ].join('\n'), 'untrusted', 'observation'));
    }
    if (item.instructionsRef) {
      const instructions = await this.readCompactionPayload(item, item.instructionsRef, 'compactionInstructions');
      for (const entry of instructions.entries) {
        content.push(textEvidence(
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

  private async projectEvidence(
    item: ContextEvidenceThreadItem,
  ): Promise<Array<TextContent | ImageContent>> {
    const payload = await this.readEvidencePayload(item);
    switch (payload.kind) {
      case 'turnEnvironment':
        return [textEvidence(payload.kind, [
          `accepted_at=${payload.utcInstant}`,
          `local_date=${payload.localDate}`,
          `local_time=${payload.localTime}`,
          `timezone=${payload.timeZone}`,
          `utc_offset_minutes=${payload.utcOffsetMinutes}`,
          `locale=${payload.locale}`,
          `working_directory=${payload.workingDirectory}`,
          `conversation_mode=${payload.conversationMode}`,
          `execution_mode=${payload.executionMode}`,
          `reply_identity=${payload.replyIdentity ?? 'none'}`,
          `today_node_id=${payload.todayNodeId ?? 'none'}`,
        ].join('\n'), 'application', 'observation')];
      case 'userView': {
        const rendered = renderUserView(this.previousUserView, payload);
        this.previousUserView = payload;
        return [
          textEvidence(payload.kind, rendered.application, 'application', 'observation'),
          ...(rendered.untrusted
            ? [textEvidence(payload.kind, rendered.untrusted, 'untrusted', 'observation')]
            : []),
        ];
      }
      case 'additionalContext':
        return payload.entries.map((entry) => textEvidence(
          payload.kind,
          entry.text,
          entry.authority,
          entry.purpose,
          [`key=${entry.key}`, `source=${entry.source}`],
        ));
      case 'referencedResources':
        return this.projectReferencedResources(payload);
      case 'skillCatalog':
        return [textEvidence(payload.kind, renderSkillCatalog(payload), 'application', 'instruction')];
      case 'skillInvocation':
        return [
          textEvidence(payload.kind, [
            `name=${payload.name}`,
            `display_name=${payload.displayName}`,
            `source=${payload.source}`,
            `identity=${payload.identity}`,
            `resource_root=${payload.resourceRoot ?? 'none'}`,
            `content_hash=${payload.contentHash}`,
            `execution=${payload.execution}`,
            `invocation_source=${payload.invocationSource}`,
            `invoked_at=${payload.invokedAt}`,
            `allowed_tools=${payload.constraints.allowedTools.join(',') || 'none'}`,
            `model=${payload.constraints.model ?? 'inherit'}`,
            `effort=${payload.constraints.effort ?? 'inherit'}`,
          ].join('\n'), 'application', 'observation'),
          ...(payload.execution === 'inline'
            ? [textEvidence(payload.kind, payload.instructions, 'application', 'instruction')]
            : []),
          ...(payload.arguments
            ? [textEvidence(payload.kind, payload.arguments, 'untrusted', 'observation', ['field=arguments'])]
            : []),
        ];
      case 'roleCatalog':
        return [textEvidence(payload.kind, renderRoleCatalog(payload), 'application', 'instruction')];
      case 'toolOutputProjection':
        return [];
      case 'inheritedContext':
        return [];
    }
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
  ): Promise<Array<TextContent | ImageContent>> {
    const content: Array<TextContent | ImageContent> = [];
    for (const resource of payload.resources) {
      let path: string | null = null;
      if (resource.resourceRef) {
        path = await this.resources.resolveResourceObservationPath(resource.resourceRef);
        if (!path) throw new Error(`Referenced resource payload is unavailable: ${resource.nodeId}`);
      }
      content.push(textEvidence('referencedResources', [
        `node_id=${resource.nodeId}`,
        `node_type=${resource.nodeType}`,
        `availability=${resource.unavailableReason ?? (resource.resourceRef ? 'available' : 'identity-only')}`,
        path ? `readable_path=${path}` : null,
        resource.contentTruncated ? 'snapshot_content_truncated=true' : null,
      ].filter((line): line is string => line !== null).join('\n'), 'application', 'observation'));
      content.push(textEvidence('referencedResources', [
        `node_id=${resource.nodeId}`,
        `title=${resource.title}`,
        `breadcrumb=${resource.breadcrumb.map((node) => `${node.title} (${node.nodeId})`).join(' / ') || 'none'}`,
        resource.content ? `snapshot_content:\n${resource.content}` : null,
      ].filter((line): line is string => line !== null).join('\n'), 'untrusted', 'observation'));
      if (resource.inlineImage && resource.resourceRef) {
        const bytes = await this.resources.readResource(resource.resourceRef);
        if (!bytes) throw new Error(`Referenced image payload is unavailable: ${resource.nodeId}`);
        content.push({ type: 'image', data: bytes.toString('base64'), mimeType: resource.resourceRef.mimeType });
      }
    }
    return content;
  }
}

export async function serializeUserContent(
  content: readonly ThreadUserContent[],
  resources: Pick<ProjectionResources, 'readResource' | 'resolveResourceObservationPath'>,
): Promise<Array<TextContent | ImageContent>> {
  assertCanonicalUserContent(content);
  const converted: Array<TextContent | ImageContent> = [];
  const impliedPrompt = impliedUserPrompt(content);
  if (impliedPrompt) converted.push({ type: 'text', text: impliedPrompt });
  for (const part of content) {
    switch (part.type) {
      case 'text':
        converted.push({ type: 'text', text: part.text });
        break;
      case 'nodeReference':
        converted.push({ type: 'text', text: `[Outliner Node ${part.nodeId}]${part.note ? ` ${part.note}` : ''}` });
        break;
      case 'attachment':
        if (part.mimeType.startsWith('image/')) {
          const promptImage = part.promptImage;
          if (!promptImage) throw new Error(`Canonical image attachment is missing its prompt snapshot: ${part.name}`);
          const image = await resources.readResource(promptImage);
          if (!image) throw new Error(`Attachment prompt image is unavailable or corrupt: ${part.name}`);
          converted.push({
            type: 'text',
            text: `[Attachment image: ${part.name}, ${part.mimeType}, ${part.sizeBytes} bytes]\nThe following image is the immutable prompt snapshot for this attachment.`,
          });
          converted.push({ type: 'image', data: image.toString('base64'), mimeType: promptImage.mimeType });
        } else {
          const location = part.source.kind === 'localFile'
            ? part.source.path
            : await resources.resolveResourceObservationPath(part.source.ref);
          if (!location) throw new Error(`Managed attachment payload is unavailable or corrupt: ${part.name}`);
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
        break;
    }
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

function textEvidence(
  kind: string,
  body: string,
  authority: 'application' | 'untrusted',
  purpose: 'instruction' | 'observation',
  metadata: readonly string[] = [],
): TextContent {
  return {
    type: 'text',
    text: [
      '<system-reminder>',
      `<context-evidence kind="${escapeXml(kind)}" authority="${authority}" purpose="${purpose}">`,
      ...metadata.map((entry) => `  <meta>${escapeXml(entry)}</meta>`),
      escapeXml(body),
      '</context-evidence>',
      '</system-reminder>',
    ].join('\n'),
  };
}

function renderUserView(
  previous: UserViewContextPayload | null,
  next: UserViewContextPayload,
): { readonly application: string; readonly untrusted: string | null } {
  const application = [
    `projection_mode=${previous ? 'diff' : 'snapshot'}`,
    `interaction_mode=${next.mode}`,
  ];
  const observation = [
    `active_panel_id=${next.activePanelId ?? 'none'}`,
    `focused_panel_id=${next.focusedPanelId ?? 'none'}`,
    `focused_node_id=${next.focusedNode?.nodeId ?? 'none'}`,
    `focus_surface=${next.focusSurface ?? 'none'}`,
    `explicit_reference_ids=${next.referencedNodes.map((node) => node.nodeId).join(',') || 'none'}`,
    `selected_node_ids=${next.selectedNodes.map((node) => node.nodeId).join(',') || 'none'}`,
    `snapshot_truncated=${next.truncated}`,
  ];
  const labels = new Map<string, string>();
  const recordLabel = (node: { readonly nodeId: string; readonly title: string }) => labels.set(node.nodeId, node.title);
  if (next.focusedNode) recordLabel(next.focusedNode);
  next.referencedNodes.forEach(recordLabel);
  next.selectedNodes.forEach(recordLabel);
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

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderSkillCatalog(payload: SkillCatalogContextPayload): string {
  return [
    `mode=${payload.mode}`,
    `previous_catalog_hash=${payload.previousCatalogHash ?? 'none'}`,
    `catalog_hash=${payload.catalogHash}`,
    ...payload.entries.map((entry) => [
      `- ${entry.name}`,
      `change=${entry.change}`,
      `display_name=${entry.displayName}`,
      `source=${entry.source}`,
      `identity=${entry.identity}`,
      `content_hash=${entry.contentHash}`,
      `description=${entry.description}`,
    ].join(' ')),
    'Use the skill tool to load a matching Skill before responding to a task it covers.',
  ].join('\n');
}

function renderRoleCatalog(payload: RoleCatalogContextPayload): string {
  return [
    `mode=${payload.mode}`,
    `previous_catalog_hash=${payload.previousCatalogHash ?? 'none'}`,
    `catalog_hash=${payload.catalogHash}`,
    ...payload.entries.map((entry) => [
      `- ${entry.name}`,
      `change=${entry.change}`,
      `display_name=${entry.displayName}`,
      `source=${entry.source}`,
      `identity=${entry.identity}`,
      `content_hash=${entry.contentHash}`,
      `description=${entry.description}`,
    ].join(' ')),
    'Pass a matching Role name as agent_type when calling collaboration.spawn_agent.',
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
  resources: Pick<ProjectionResources, 'readOutput' | 'readResource'>,
  projection: ToolOutputProjectionContextPayload | null,
): Promise<{ call: ToolCall; result: ToolResultMessage }> {
  const identity = historyToolIdentity(item);
  const toolName = identity.namespace ? `${identity.namespace}__${identity.name}` : identity.name;
  return {
    call: { type: 'toolCall', id: item.id, name: toolName, arguments: historyToolArguments(item) },
    result: {
      role: 'toolResult',
      toolCallId: item.id,
      toolName,
      content: await historyToolResultContent(item, resources, projection),
      isError: item.status !== 'completed',
      timestamp,
    },
  };
}

function historyToolIdentity(item: HistoryToolItem): { namespace: string | null; name: string } {
  switch (item.type) {
    case 'commandExecution': return { namespace: null, name: 'bash' };
    case 'fileChange': {
      const kinds = new Set(item.changes.map((change) => change.kind));
      return { namespace: null, name: kinds.size === 1 && kinds.has('add')
        ? 'file_write'
        : kinds.size === 1 && kinds.has('delete') ? 'file_delete' : 'file_edit' };
    }
    case 'mcpToolCall': return { namespace: item.server, name: item.tool };
    case 'dynamicToolCall': return { namespace: item.namespace, name: item.tool };
    case 'collabAgentToolCall': return { namespace: 'collaboration', name: item.tool };
    case 'webSearch': return { namespace: null, name: 'web_search' };
  }
}

function historyToolArguments(item: HistoryToolItem): Record<string, unknown> {
  switch (item.type) {
    case 'commandExecution': return { command: item.command, cwd: item.cwd };
    case 'fileChange': return { changes: item.changes };
    case 'mcpToolCall':
    case 'dynamicToolCall': return isRecord(item.arguments) ? item.arguments : { value: item.arguments };
    case 'collabAgentToolCall': return {
      ...(item.prompt === null ? {} : { message: item.prompt }),
      ...(item.model === null ? {} : { model: item.model }),
      ...(item.reasoningEffort === null ? {} : { reasoning_effort: item.reasoningEffort }),
    };
    case 'webSearch': return { query: item.query };
  }
}

async function historyToolResultContent(
  item: HistoryToolItem,
  resources: Pick<ProjectionResources, 'readOutput' | 'readResource'>,
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
        const ref = 'promptImage' in part ? part.promptImage : part.source.ref;
        const bytes = await resources.readResource(ref);
        if (!bytes) throw new Error(`Tool image payload is unavailable or corrupt: ${ref.fileName}`);
        content.push({ type: 'text', text: dynamicToolImageIdentity(part, ref) });
        content.push({ type: 'image', data: bytes.toString('base64'), mimeType: ref.mimeType });
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

function dynamicToolImageIdentity(
  part: Extract<NonNullable<Extract<ThreadItem, { type: 'dynamicToolCall' }>['contentItems']>[number], { type: 'image' }>,
  ref: ThreadResourceReference,
): string {
  const source = part.source.kind === 'localFile' ? part.source.path : part.source.ref.fileName;
  const alt = part.alt?.trim().replace(/\s+/g, ' ');
  const label = alt && alt !== source ? `${alt} (${source})` : alt || source;
  return `[Image output: ${label}, ${ref.mimeType}, ${ref.byteLength} bytes]`;
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

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
