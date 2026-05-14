import type { AgentMessage, UserMessage } from './agentTypes';

export interface AgentChatMessageNode {
  id: string;
  parentId: string | null;
  children: string[];
  currentChild: string | null;
  level: number;
  message: AgentMessage | null;
}

export interface AgentChatSession {
  id: string;
  title: string | null;
  mapping: Record<string, AgentChatMessageNode>;
  currentNode: string;
  createdAt: number;
  updatedAt: number;
}

type TreeOp = 'cut' | 'link' | 'relink';

function createId(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function getNodeOrThrow(session: AgentChatSession, nodeId: string): AgentChatMessageNode {
  const node = session.mapping[nodeId];
  if (!node) throw new Error(`Missing chat message node: ${nodeId}`);
  return node;
}

function touchSession(session: AgentChatSession) {
  session.updatedAt = Date.now();
}

function createMessageNode(
  message: AgentMessage | null,
  parentId: string | null,
  level: number,
): AgentChatMessageNode {
  return {
    id: createId('msg'),
    parentId,
    children: [],
    currentChild: null,
    level,
    message,
  };
}

function updateSubtreeLevels(session: AgentChatSession, nodeId: string, level: number) {
  const node = getNodeOrThrow(session, nodeId);
  node.level = level;
  for (const childId of node.children) {
    updateSubtreeLevels(session, childId, level + 1);
  }
}

function performOp(
  session: AgentChatSession,
  child: AgentChatMessageNode,
  op: TreeOp,
  newParentId?: string,
) {
  const existingChild = session.mapping[child.id];
  const childNode = existingChild ?? child;
  const oldParent = childNode.parentId ? getNodeOrThrow(session, childNode.parentId) : null;
  let newParent: AgentChatMessageNode | null = null;

  if (op === 'relink' && childNode.parentId === newParentId) return;

  if (op === 'link' || op === 'relink') {
    if (!newParentId) throw new Error('Linking a chat message requires a parent id');
    newParent = getNodeOrThrow(session, newParentId);
    let cursor: AgentChatMessageNode | undefined = newParent;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor.id === childNode.id) throw new Error('Cannot create a cycle in chat message tree');
      if (visited.has(cursor.id)) break;
      visited.add(cursor.id);
      cursor = cursor.parentId ? session.mapping[cursor.parentId] : undefined;
    }
  }

  if (!existingChild && (op === 'link' || op === 'relink')) {
    session.mapping[childNode.id] = childNode;
  }

  if (op === 'cut' || op === 'relink') {
    if (oldParent) {
      oldParent.children = oldParent.children.filter((childId) => childId !== childNode.id);
      if (oldParent.currentChild === childNode.id) {
        oldParent.currentChild = oldParent.children.at(-1) ?? null;
      }
    }
    childNode.parentId = null;
    if (op === 'cut') {
      touchSession(session);
      return;
    }
  }

  if (!newParent) return;
  if (!newParent.children.includes(childNode.id)) {
    newParent.children = [...newParent.children, childNode.id];
  }
  childNode.parentId = newParent.id;
  newParent.currentChild = childNode.id;
  updateSubtreeLevels(session, childNode.id, newParent.level + 1);
  touchSession(session);
}

function getPendingLeafPlaceholder(session: AgentChatSession): AgentChatMessageNode | null {
  const node = session.mapping[session.currentNode];
  if (!node || node.message !== null || node.parentId === null || node.children.length > 0) return null;
  return node;
}

export function createAgentChatSession(id = createId('chat')): AgentChatSession {
  const now = Date.now();
  const rootNode = createMessageNode(null, null, 0);
  return {
    id,
    title: 'Untitled',
    mapping: {
      [rootNode.id]: rootNode,
    },
    currentNode: rootNode.id,
    createdAt: now,
    updatedAt: now,
  };
}

export function getAgentChatNode(session: AgentChatSession, nodeId: string): AgentChatMessageNode | null {
  return session.mapping[nodeId] ?? null;
}

export function appendAgentChatMessage(session: AgentChatSession, message: AgentMessage): AgentChatMessageNode {
  const parent = getNodeOrThrow(session, session.currentNode);
  const node = createMessageNode(message, parent.id, parent.level + 1);
  performOp(session, node, 'link', parent.id);
  session.currentNode = node.id;
  return node;
}

export function getAgentChatLinearPath(session: AgentChatSession): AgentChatMessageNode[] {
  const head = session.mapping[session.currentNode];
  if (!head) return [];

  const path: Array<AgentChatMessageNode | undefined> = [];
  const visited = new Set<string>();
  for (
    let cursor: AgentChatMessageNode | undefined = head;
    cursor;
    cursor = cursor.parentId ? session.mapping[cursor.parentId] : undefined
  ) {
    if (visited.has(cursor.id)) break;
    visited.add(cursor.id);
    if (cursor.message !== null) path[cursor.level] = cursor;
  }

  return path.filter((node): node is AgentChatMessageNode => node !== undefined);
}

export function getAgentChatMessages(session: AgentChatSession): AgentMessage[] {
  return getAgentChatLinearPath(session).map((node) => node.message).filter(Boolean) as AgentMessage[];
}

export function syncAgentMessagesToChatTree(session: AgentChatSession, agentMessages: AgentMessage[]) {
  const linearPath = getAgentChatLinearPath(session);
  let nextIndex = linearPath.length;
  const placeholder = getPendingLeafPlaceholder(session);

  if (placeholder && nextIndex < agentMessages.length) {
    placeholder.message = agentMessages[nextIndex] ?? null;
    touchSession(session);
    nextIndex += 1;
  }

  for (let index = nextIndex; index < agentMessages.length; index += 1) {
    const message = agentMessages[index];
    if (message) appendAgentChatMessage(session, message);
  }
}

export function editAgentChatUserMessage(
  session: AgentChatSession,
  nodeId: string,
  content: UserMessage['content'],
): AgentChatMessageNode {
  const target = getNodeOrThrow(session, nodeId);
  if (!target.parentId) throw new Error('Cannot edit chat root');
  if (target.message?.role !== 'user') throw new Error('Only user messages can be edited');
  const sibling = createMessageNode({
    role: 'user',
    content,
    timestamp: Date.now(),
  }, target.parentId, target.level);
  performOp(session, sibling, 'link', target.parentId);
  session.currentNode = sibling.id;
  return sibling;
}

export function regenerateAgentChatMessage(session: AgentChatSession, nodeId: string): AgentChatMessageNode {
  const target = getNodeOrThrow(session, nodeId);
  if (!target.parentId) throw new Error('Cannot regenerate chat root');
  const sibling = createMessageNode(null, target.parentId, target.level);
  performOp(session, sibling, 'link', target.parentId);
  session.currentNode = sibling.id;
  return sibling;
}

export function switchAgentChatBranch(session: AgentChatSession, nodeId: string) {
  const node = getNodeOrThrow(session, nodeId);
  if (!node.parentId) {
    session.currentNode = node.id;
    touchSession(session);
    return;
  }

  const parent = getNodeOrThrow(session, node.parentId);
  parent.currentChild = node.id;
  session.currentNode = findLatestAgentChatLeaf(session, node.id).id;
  touchSession(session);
}

export function getAgentChatBranches(session: AgentChatSession, nodeId: string): string[] {
  const node = session.mapping[nodeId];
  if (!node?.parentId) return [];
  return getNodeOrThrow(session, node.parentId).children.slice();
}

export function findLatestAgentChatLeaf(session: AgentChatSession, nodeId: string): AgentChatMessageNode {
  let cursor = getNodeOrThrow(session, nodeId);
  const visited = new Set<string>();
  while (cursor.currentChild) {
    if (visited.has(cursor.id)) break;
    visited.add(cursor.id);
    const next = session.mapping[cursor.currentChild];
    if (!next) break;
    cursor = next;
  }
  return cursor;
}

export function deriveAgentChatTitle(messages: AgentMessage[]): string | null {
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) return null;
  const raw = typeof firstUser.content === 'string'
    ? firstUser.content
    : firstUser.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 30) : null;
}
