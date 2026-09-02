import type {
  ContextAuthority,
  ContextDegradationCheckpointEntry,
  ContextPurpose,
  ContextTextEntry,
  ReferencedResourcesContextPayload,
  RoleCatalogContextPayload,
  SkillCatalogContextPayload,
  SkillInvocationContextPayload,
  TurnEnvironmentContextPayload,
  UserViewContextPayload,
  UserViewNodeSnapshot,
  UserViewTargetSnapshot,
} from '../../../core/agent/protocol';
import {
  formatFileReferenceMarker,
  formatNamedFileReference,
  formatNamedNodeReference,
  formatNodeReferenceMarker,
  formatThreadReferenceMarker,
  parseFileReferenceUri,
} from '../../../core/referenceMarkup';

export interface TurnBriefBlock {
  readonly authority: ContextAuthority;
  readonly purpose: ContextPurpose;
  readonly body: string;
}

export function environmentBrief(
  previous: TurnEnvironmentContextPayload | null,
  next: TurnEnvironmentContextPayload,
): TurnBriefBlock {
  const lines = [
    `Local time at this input: ${next.localDate}T${next.localTime}${formatUtcOffset(next.utcOffsetMinutes)} [${next.timeZone}].`,
  ];
  if (!previous || previous.workingDirectory !== next.workingDirectory) {
    lines.push(`Working directory: ${next.workingDirectory}.`);
  }
  if (!previous) {
    const execution = executionDescription(next);
    if (execution) lines.push(`Execution: ${execution}.`);
  } else if (
    previous.conversationMode !== next.conversationMode
    || previous.executionMode !== next.executionMode
  ) {
    lines.push(`Execution: ${executionDescription(next) ?? 'ordinary interactive root'}.`);
  }
  return observation('application', lines.join('\n'));
}

export function userViewBrief(
  previous: UserViewContextPayload | null,
  next: UserViewContextPayload,
): readonly TurnBriefBlock[] {
  const blocks: TurnBriefBlock[] = [];
  if (!previous || viewSignature(previous) !== viewSignature(next)) {
    const body = viewStatement(next);
    if (body) blocks.push(observation('untrusted', body));
  }

  const previousFocus = distinctFocus(previous);
  const nextFocus = distinctFocus(next);
  if (!sameFocus(previous, previousFocus, next, nextFocus)) {
    if (nextFocus) {
      const reference = namedNode(nextFocus);
      blocks.push(observation('untrusted', next.focusSurface === 'trailing'
        ? `Insertion target: children of ${reference}.`
        : `Focused node: ${reference}.`));
    } else if (previousFocus) {
      blocks.push(observation('untrusted', activePanel(next)
        ? 'Focus returned to the active view.'
        : 'Focus cleared.'));
    }
  }

  if (
    !sameNodes(previous?.selectedNodes ?? [], next.selectedNodes)
    || previous?.selectionTruncated !== next.selectionTruncated
  ) {
    if (next.selectedNodes.length > 0) {
      blocks.push(observation('untrusted', [
        `Selected: ${next.selectedNodes.map(namedNode).join('; ')}.`,
        next.selectionTruncated ? '[Selection truncated.]' : null,
      ].filter((line): line is string => line !== null).join('\n')));
    } else if ((previous?.selectedNodes.length ?? 0) > 0) {
      blocks.push(observation('untrusted', 'Selection cleared.'));
    }
  }

  if (!previous || suppliedOutlineSignature(previous) !== suppliedOutlineSignature(next)) {
    for (const supplied of next.suppliedOutline) {
      const source = namedNode({
        nodeId: supplied.sourceNodeId,
        title: supplied.sourceTitle,
      });
      const lines = supplied.outline.map((node) => (
        `${'  '.repeat(node.depth)}- ${node.title}`
      ));
      if (supplied.visibleOutlineTruncated) lines.push('[Visible Outline content truncated.]');
      if (lines.length > 0) {
        blocks.push(observation('untrusted', `Supplied Outline content from ${source}:\n${lines.join('\n')}`));
      }
    }
  }
  return blocks;
}

export function skillCatalogBrief(payload: SkillCatalogContextPayload): TurnBriefBlock {
  return observation('application', catalogBrief('Skills', payload.mode, payload.entries));
}

export function roleCatalogBrief(payload: RoleCatalogContextPayload): TurnBriefBlock {
  return observation('application', catalogBrief('Agent types', payload.mode, payload.entries));
}

export function skillInvocationBrief(payload: SkillInvocationContextPayload): readonly TurnBriefBlock[] {
  const constraints = [
    payload.execution !== 'inline' ? `Execution: ${payload.execution}.` : null,
    payload.constraints.allowedTools.length > 0
      ? `Allowed tools: ${payload.constraints.allowedTools.join(', ')}.`
      : null,
    payload.constraints.model ? `Model: ${payload.constraints.model}.` : null,
    payload.constraints.effort ? `Reasoning effort: ${payload.constraints.effort}.` : null,
  ].filter((entry): entry is string => entry !== null);
  const label = payload.displayName === payload.name
    ? payload.name
    : `${payload.displayName} (${payload.name})`;
  return [
    observation('application', [`Active Skill: ${label}.`, ...constraints].join('\n')),
    ...(payload.execution === 'inline'
      ? [instruction(payload.instructions)]
      : []),
  ];
}

export function contextEntryBrief(entry: ContextTextEntry): TurnBriefBlock {
  return { authority: entry.authority, purpose: entry.purpose, body: entry.text };
}

export function contextRevocationBrief(entry: ContextTextEntry): TurnBriefBlock {
  const scope = entry.scope?.trim();
  if (entry.purpose === 'instruction') {
    return instruction(scope
      ? `Stop applying the "${scope}" instructions.`
      : 'The prior application instructions are no longer active.');
  }
  return observation(entry.authority, scope
    ? `The "${scope}" context is no longer active.`
    : 'A prior application context is no longer active.');
}

export function suppliedFileBrief(input: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly readablePath: string | null;
}): TurnBriefBlock {
  return observation('untrusted', input.readablePath
    ? `Supplied file ${formatNamedFileReference(input.readablePath, 'file', input.fileName)} (${input.mimeType}, ${input.byteLength} bytes).`
    : `Supplied file "${input.fileName}" is unavailable.`);
}

export function referencedResourceBrief(
  resource: ReferencedResourcesContextPayload['resources'][number],
  readablePath: string | null,
): TurnBriefBlock {
  const nodeReference = formatNamedNodeReference(
    resource.nodeId,
    resource.title,
    { unavailable: 'display' },
  );
  const breadcrumb = resource.breadcrumb.map((node) => node.title).filter(Boolean).join(' / ');
  return observation('untrusted', [
    `Supplied Node: ${nodeReference}${breadcrumb ? ` at ${breadcrumb}` : ''}.`,
    resource.unavailableReason ? `Content unavailable: ${resource.unavailableReason}.` : null,
    readablePath && resource.resourceRef
      ? `Readable resource: ${formatNamedFileReference(
          readablePath,
          resource.resourceRef.mimeType === 'inode/directory' ? 'directory' : 'file',
          resource.title || resource.resourceRef.fileName,
        )}.`
      : null,
    resource.content ? `Supplied content:\n${resource.content}` : null,
    resource.contentTruncated ? '[Supplied content truncated.]' : null,
  ].filter((line): line is string => line !== null).join('\n'));
}

export function compactionSummaryBrief(text: string): TurnBriefBlock {
  return observation('untrusted', `Earlier conversation:\n${text}`);
}

export function historicalToolOutputBrief(input: {
  readonly tool: string;
  readonly subject: string;
  readonly text: string;
}): readonly TurnBriefBlock[] {
  const subject = input.subject.trim() ? ` for ${input.subject.trim()}` : '';
  return [
    observation('untrusted', `Historical ${input.tool} output${subject}:\n${input.text}`),
    instruction('Read the current source again before relying on this historical output if it may have changed.'),
  ];
}

export function degradationBrief(entry: ContextDegradationCheckpointEntry): TurnBriefBlock {
  const affected = entry.source
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/[-_]+/gu, ' ')
    .trim()
    .toLowerCase();
  return observation(
    'application',
    `${affected || 'Historical context'} could not be restored. Re-inspect current state before relying on it.`,
  );
}

export function observation(
  authority: ContextAuthority,
  body: string,
): TurnBriefBlock {
  return { authority, purpose: 'observation', body };
}

export function instruction(body: string): TurnBriefBlock {
  return { authority: 'application', purpose: 'instruction', body };
}

function viewStatement(payload: UserViewContextPayload): string | null {
  const panels = [...payload.panels].sort((left, right) => left.order - right.order);
  if (panels.length === 0) {
    return payload.viewsComplete
      ? 'No application view is currently open.'
      : 'The current application view could not be resolved.';
  }
  const active = activePanel(payload);
  if (!active) {
    const open = panels.slice(0, 4).map((panel) => targetDescription(panel.target)).join('; ');
    return `Open views, left to right: ${open}.${payload.viewsComplete ? '' : ' Some open views could not be resolved.'}`;
  }
  const other = panels.filter((panel) => panel !== active).slice(0, 3);
  const primary = `Viewing ${targetDescription(active.target)}`;
  const statement = other.length === 0
    ? `${primary}.`
    : `${primary}. Other open views, left to right: ${other.map((panel) => targetDescription(panel.target)).join('; ')}.`;
  return payload.viewsComplete ? statement : `${statement} Some other open views could not be resolved.`;
}

function targetDescription(target: UserViewTargetSnapshot): string {
  switch (target.kind) {
    case 'node': {
      const breadcrumb = target.breadcrumb.map((node) => node.title).filter(Boolean).join(' / ');
      return `${quoted(target.title)} ${formatNodeReferenceMarker(target.nodeId)}${breadcrumb ? ` at ${breadcrumb}` : ''}`;
    }
    case 'local-file':
      return `${target.entryKind === 'directory' ? 'directory' : 'file'} ${quoted(target.label)}${readableFileReference(target.path, target.entryKind)}${ownerClause(target.ownerNode)}`;
    case 'asset':
      return `asset ${quoted(target.label)}${ownerClause(target.ownerNode)}`;
    case 'linked-file': {
      return `linked file ${quoted(target.label)}${readableFileReference(target.sourceText)}${ownerClause(target.ownerNode)}`;
    }
    case 'url': {
      const url = readableHttpUrl(target.url);
      return url
        ? `${target.label ? `${quoted(target.label)} at ` : ''}${url}${ownerClause(target.ownerNode)}`
        : `URL ${quoted(target.label ?? 'Unavailable URL')}${ownerClause(target.ownerNode)}`;
    }
    case 'thread-trajectory':
      return `trajectory for Thread ${quoted(target.threadName)} ${formatThreadReferenceMarker(target.threadId)}${target.turnId ? `, Turn ${target.turnId}` : ''}`;
  }
}

function ownerClause(owner: UserViewNodeSnapshot | null): string {
  return owner ? `, from ${namedNode(owner)}` : '';
}

function namedNode(node: Pick<UserViewNodeSnapshot, 'nodeId' | 'title'>): string {
  return `${quoted(node.title)} ${formatNodeReferenceMarker(node.nodeId)}`;
}

function distinctFocus(payload: UserViewContextPayload | null): UserViewNodeSnapshot | null {
  if (!payload?.focusedNode) return null;
  const active = activePanel(payload);
  return active?.target.kind === 'node' && active.target.nodeId === payload.focusedNode.nodeId
    ? null
    : payload.focusedNode;
}

function viewSignature(payload: UserViewContextPayload): string {
  return JSON.stringify({
    viewsComplete: payload.viewsComplete,
    panels: [...payload.panels]
    .sort((left, right) => left.order - right.order)
    .map((panel) => ({
      order: panel.order,
      active: panel.panelId === payload.activePanelId || panel.active,
      target: visibleTarget(panel.target),
    })),
  });
}

function activePanel(payload: UserViewContextPayload) {
  return payload.panels.find((panel) => panel.panelId === payload.activePanelId)
    ?? payload.panels.find((panel) => panel.active)
    ?? null;
}

function visibleTarget(target: UserViewTargetSnapshot): unknown {
  switch (target.kind) {
    case 'node':
      return {
        kind: target.kind,
        nodeId: target.nodeId,
        title: target.title,
        breadcrumb: target.breadcrumb.map(nodeIdentity),
      };
    case 'local-file':
      return {
        kind: target.kind,
        path: target.path,
        entryKind: target.entryKind,
        label: target.label,
        ownerNode: target.ownerNode ? nodeIdentity(target.ownerNode) : null,
      };
    case 'asset':
      return {
        kind: target.kind,
        label: target.label,
        ownerNode: target.ownerNode ? nodeIdentity(target.ownerNode) : null,
      };
    case 'linked-file':
      return {
        kind: target.kind,
        sourceText: target.sourceText,
        label: target.label,
        ownerNode: target.ownerNode ? nodeIdentity(target.ownerNode) : null,
      };
    case 'url':
      return {
        kind: target.kind,
        url: target.url,
        label: target.label,
        ownerNode: target.ownerNode ? nodeIdentity(target.ownerNode) : null,
      };
    case 'thread-trajectory':
      return {
        kind: target.kind,
        threadId: target.threadId,
        threadName: target.threadName,
        turnId: target.turnId,
      };
  }
}

function suppliedOutlineSignature(payload: UserViewContextPayload): string {
  return JSON.stringify(payload.suppliedOutline.map((supplied) => ({
    sourceNodeId: supplied.sourceNodeId,
    sourceTitle: supplied.sourceTitle,
    outline: supplied.outline,
    visibleOutlineTruncated: supplied.visibleOutlineTruncated,
  })));
}

function readableFileReference(
  value: string,
  entryKind: 'file' | 'directory' = 'file',
): string {
  const parsed = parseFileReferenceUri(value);
  const marker = parsed
    ? formatFileReferenceMarker(parsed.path, parsed.entryKind)
    : formatFileReferenceMarker(value, entryKind);
  return marker.startsWith('[[') ? ` ${marker}` : '';
}

function readableHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.toString() : null;
  } catch {
    return null;
  }
}

function executionDescription(payload: TurnEnvironmentContextPayload): string | null {
  if (payload.conversationMode === 'interactive' && payload.executionMode === 'root') return null;
  switch (payload.executionMode) {
    case 'automation': return 'headless Automation';
    case 'memory': return 'headless Memory consolidation';
    case 'child': return 'delegated child Agent';
    case 'feature': return 'Host feature execution';
    case 'root': return 'headless root Agent';
  }
}

function catalogBrief(
  label: string,
  mode: 'baseline' | 'delta',
  entries: readonly {
    readonly change: 'available' | 'added' | 'changed' | 'removed';
    readonly name: string;
    readonly displayName: string;
    readonly description: string;
  }[],
): string {
  const heading = mode === 'baseline' ? `Available ${label}:` : `${label} changed:`;
  return [heading, ...entries.map((entry) => {
    const change = mode === 'delta' ? `${catalogChange(entry.change)} ` : '';
    const name = entry.displayName === entry.name
      ? entry.name
      : `${entry.displayName} (${entry.name})`;
    return `- ${change}${name}: ${entry.description}`;
  })].join('\n');
}

function catalogChange(change: 'available' | 'added' | 'changed' | 'removed'): string {
  if (change === 'changed') return 'Updated';
  return change === 'available' ? 'Available' : `${change[0]!.toUpperCase()}${change.slice(1)}`;
}

function sameNode(left: UserViewNodeSnapshot | null, right: UserViewNodeSnapshot | null): boolean {
  return left?.nodeId === right?.nodeId && left?.title === right?.title;
}

function sameFocus(
  leftPayload: UserViewContextPayload | null,
  leftNode: UserViewNodeSnapshot | null,
  rightPayload: UserViewContextPayload,
  rightNode: UserViewNodeSnapshot | null,
): boolean {
  return sameNode(leftNode, rightNode)
    && focusRelation(leftPayload, leftNode) === focusRelation(rightPayload, rightNode);
}

function focusRelation(
  payload: UserViewContextPayload | null,
  node: UserViewNodeSnapshot | null,
): 'node' | 'insertion' | null {
  if (!node) return null;
  return payload?.focusSurface === 'trailing' ? 'insertion' : 'node';
}

function sameNodes(left: readonly UserViewNodeSnapshot[], right: readonly UserViewNodeSnapshot[]): boolean {
  return JSON.stringify(left.map(nodeIdentity)) === JSON.stringify(right.map(nodeIdentity));
}

function nodeIdentity(node: UserViewNodeSnapshot): readonly [string, string] {
  return [node.nodeId, node.title];
}

function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function quoted(value: string): string {
  return `"${value.replace(/"/gu, '\\"')}"`;
}
