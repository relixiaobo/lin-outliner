import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentConversation, AgentConversationListMeta, AgentCreateConversationOptions } from '../core/types';
import type { AgentDefinitionView } from '../core/agentTypes';
import { DEFAULT_GENERAL_CHANNEL_ID, agentMentionToken } from '../core/agentChannel';
import { sanitizeConversationTitle } from '../core/agentConversationTitle';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import {
  optionalString as optionalToolString,
  recordParams,
  requiredString as requiredToolString,
  uniqueStrings,
} from './agentToolParams';

export interface AgentChannelToolRuntime {
  currentConversationId(): string;
  createConversation(options: AgentCreateConversationOptions): Promise<AgentConversation>;
  updateConversation(
    conversationId: string,
    options: AgentChannelUpdateOptions,
  ): Promise<AgentChannelUpdateResult>;
  listConversations(): Promise<AgentConversationListMeta[]>;
  listAllAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]>;
}

export interface AgentChannelUpdateOptions {
  title?: string;
  addAgentIds?: readonly string[];
  removeAgentIds?: readonly string[];
}

export interface AgentChannelUpdateResult {
  conversation: AgentConversationListMeta;
  addedAgentIds: string[];
  removedAgentIds: string[];
  renamed: boolean;
}

export interface ChannelToolMemberData {
  agent_id: string;
  mention: string;
  name: string;
}

export interface ChannelToolData {
  conversation_id: string;
  name: string;
  members: ChannelToolMemberData[];
  added_member_agent_ids?: string[];
  removed_member_agent_ids?: string[];
  renamed?: boolean;
}

const CHANNEL_CREATE_TOOL = 'channel_create';
const CHANNEL_UPDATE_TOOL = 'channel_update';
const MAX_CHANNEL_NAME_LENGTH = 120;
const MAX_CHANNEL_SEED_LENGTH = 4_000;
const MAX_MEMBER_EDITS = 20;

const CHANNEL_CREATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CHANNEL_NAME_LENGTH,
      description: 'Required Channel name, for a persistent multi-agent working group the user explicitly requested.',
    },
    member_agent_ids: {
      type: 'array',
      maxItems: MAX_MEMBER_EDITS,
      items: { type: 'string', minLength: 1 },
      description: 'Agent ids, names, or @mentions to invite. Use unambiguous entries from the current agent roster; the coordinator is included automatically.',
    },
    member_names: {
      type: 'array',
      maxItems: MAX_MEMBER_EDITS,
      items: { type: 'string', minLength: 1 },
      description: 'Optional agent names or @mentions to invite when an exact agent id is not known.',
    },
    opening_message: {
      type: 'string',
      maxLength: MAX_CHANNEL_SEED_LENGTH,
      description: 'Optional first user-visible message shared in the new Channel.',
    },
  },
} as const;

const CHANNEL_UPDATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversation_id: {
      type: 'string',
      minLength: 1,
      description: 'Optional Channel conversation id. Omit to edit the current Channel, or pass channel_name.',
    },
    channel_name: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CHANNEL_NAME_LENGTH,
      description: 'Optional existing Channel name. Must uniquely match one Channel when conversation_id is omitted.',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CHANNEL_NAME_LENGTH,
      description: 'Optional replacement Channel name.',
    },
    add_member_agent_ids: {
      type: 'array',
      maxItems: MAX_MEMBER_EDITS,
      items: { type: 'string', minLength: 1 },
      description: 'Agent ids, names, or @mentions to add to the Channel.',
    },
    add_member_names: {
      type: 'array',
      maxItems: MAX_MEMBER_EDITS,
      items: { type: 'string', minLength: 1 },
      description: 'Optional agent names or @mentions to add when an exact agent id is not known.',
    },
    remove_member_agent_ids: {
      type: 'array',
      maxItems: MAX_MEMBER_EDITS,
      items: { type: 'string', minLength: 1 },
      description: 'Agent ids, names, or @mentions to remove from the Channel. The coordinator, #General, and DMs cannot be edited this way.',
    },
    remove_member_names: {
      type: 'array',
      maxItems: MAX_MEMBER_EDITS,
      items: { type: 'string', minLength: 1 },
      description: 'Optional agent names or @mentions to remove when an exact agent id is not known.',
    },
  },
} as const;

export function createChannelOrgTools(runtime: AgentChannelToolRuntime): AgentTool<any>[] {
  return [
    {
      name: CHANNEL_CREATE_TOOL,
      label: 'Create Channel',
      description: [
        'Create a local Tenon Channel for a persistent multi-agent working group the user explicitly asked for.',
        'Use this for named, ongoing work with multiple agents; otherwise keep the conversation in #General or a DM.',
        'The coordinator is included automatically. Invite only known agent ids, names, or @mentions from the roster, then announce the created Channel in chat.',
      ].join(' '),
      parameters: CHANNEL_CREATE_PARAMETERS,
      executionMode: 'sequential',
      execute: async (_toolCallId, rawParams: unknown) => {
        const started = Date.now();
        try {
          const params = normalizeChannelCreateParams(rawParams);
          const definitions = await runtime.listAllAgentDefinitions(runtime.currentConversationId());
          const memberAgentIds = resolveAgentRefs(
            definitions,
            params.memberRefs,
            'member reference',
          );
          const created = await runtime.createConversation({
            title: params.name,
            ...(memberAgentIds.length > 0 ? { agentIds: memberAgentIds } : {}),
            ...(params.openingMessage ? { seedText: params.openingMessage } : {}),
          });
          return channelToolResult(
            CHANNEL_CREATE_TOOL,
            summarizeCreatedChannel(created),
            started,
            'Announce the new Channel and its members. Do not claim any member has started work unless the user asks in that Channel.',
          );
        } catch (error) {
          return channelToolError(CHANNEL_CREATE_TOOL, 'CHANNEL_CREATE_FAILED', errorMessage(error), started);
        }
      },
    },
    {
      name: CHANNEL_UPDATE_TOOL,
      label: 'Update Channel',
      description: [
        'Edit a local Tenon Channel by renaming it and/or adding/removing agent members.',
        'Use only for an explicit user request to change a Channel. Omit conversation_id to edit the current Channel, or pass channel_name when it uniquely identifies a Channel.',
        'This does not delete Channels and cannot edit #General or canonical DMs.',
      ].join(' '),
      parameters: CHANNEL_UPDATE_PARAMETERS,
      executionMode: 'sequential',
      execute: async (_toolCallId, rawParams: unknown) => {
        const started = Date.now();
        try {
          const params = normalizeChannelUpdateParams(rawParams);
          const conversations = await runtime.listConversations();
          const target = resolveChannelTarget(conversations, runtime.currentConversationId(), params);
          const definitions = await runtime.listAllAgentDefinitions(target.id);
          const addMemberAgentIds = resolveAgentRefs(definitions, params.addMemberRefs, 'add member reference');
          const removeMemberAgentIds = resolveAgentRefs(definitions, params.removeMemberRefs, 'remove member reference');
          const overlap = addMemberAgentIds.find((agentId) => removeMemberAgentIds.includes(agentId));
          if (overlap) throw new Error(`Agent ${overlap} cannot be both added and removed in one update.`);
          const updated = await runtime.updateConversation(target.id, {
            ...(params.name ? { title: params.name } : {}),
            ...(addMemberAgentIds.length > 0 ? { addAgentIds: addMemberAgentIds } : {}),
            ...(removeMemberAgentIds.length > 0 ? { removeAgentIds: removeMemberAgentIds } : {}),
          });
          return channelToolResult(
            CHANNEL_UPDATE_TOOL,
            {
              ...summarizeChannel(updated.conversation, definitions),
              ...(updated.renamed ? { renamed: true } : {}),
              ...(updated.addedAgentIds.length > 0 ? { added_member_agent_ids: updated.addedAgentIds } : {}),
              ...(updated.removedAgentIds.length > 0 ? { removed_member_agent_ids: updated.removedAgentIds } : {}),
            },
            started,
            'Summarize the Channel changes that actually applied. If nothing changed, say the Channel already matched the request.',
          );
        } catch (error) {
          return channelToolError(CHANNEL_UPDATE_TOOL, 'CHANNEL_UPDATE_FAILED', errorMessage(error), started);
        }
      },
    },
  ];
}

function resolveChannelTarget(
  conversations: readonly AgentConversationListMeta[],
  currentConversationId: string,
  params: ChannelUpdateParams,
): AgentConversationListMeta {
  if (params.conversationId && params.channelName) {
    throw new Error('Pass either conversation_id or channel_name, not both.');
  }

  if (params.conversationId) {
    const match = conversations.find((conversation) => conversation.id === params.conversationId);
    if (!match) throw new Error(`No Channel with conversation_id "${params.conversationId}" was found.`);
    if (!isMutableChannelRow(match)) throw new Error('#General and DMs cannot be edited.');
    return match;
  }

  if (params.channelName) {
    const normalized = normalizeTitle(params.channelName);
    const matches = channelRows(conversations).filter((conversation) => normalizeTitle(conversation.title) === normalized);
    if (matches.length === 0) throw new Error(`No Channel named "${params.channelName}" was found.`);
    if (matches.length > 1) throw new Error(`More than one Channel is named "${params.channelName}". Pass conversation_id.`);
    if (!isMutableChannelRow(matches[0]!)) throw new Error('#General and DMs cannot be edited.');
    return matches[0]!;
  }

  const current = conversations.find((conversation) => conversation.id === currentConversationId);
  if (!current || !isMutableChannelRow(current)) {
    throw new Error('The current conversation is not an editable Channel. Pass conversation_id or channel_name.');
  }
  return current;
}

function summarizeCreatedChannel(conversation: AgentConversation): ChannelToolData {
  return {
    conversation_id: conversation.conversationId,
    name: normalizeTitle(conversation.renderProjection.conversationTitle) || 'Untitled',
    members: conversation.renderProjection.members.flatMap((member) => {
      if (member.principal.type !== 'agent') return [];
      return [{
        agent_id: member.principal.agentId,
        mention: member.mention || agentMentionToken(member.principal.agentId),
        name: member.displayName || agentMentionToken(member.principal.agentId),
      }];
    }),
  };
}

function summarizeChannel(
  conversation: AgentConversationListMeta,
  definitions: readonly AgentDefinitionView[],
): ChannelToolData {
  const definitionsById = new Map(definitions.map((definition) => [definition.agentId, definition]));
  return {
    conversation_id: conversation.id,
    name: normalizeTitle(conversation.title) || 'Untitled',
    members: conversation.members.flatMap((member) => {
      if (member.type !== 'agent') return [];
      const definition = definitionsById.get(member.agentId);
      return [{
        agent_id: member.agentId,
        mention: agentMentionToken(member.agentId),
        name: definition?.displayName?.trim() || definition?.name || agentMentionToken(member.agentId),
      }];
    }),
  };
}

interface ChannelCreateParams {
  name: string;
  memberRefs: string[];
  openingMessage?: string;
}

interface ChannelUpdateParams {
  conversationId?: string;
  channelName?: string;
  name?: string;
  addMemberRefs: string[];
  removeMemberRefs: string[];
}

function normalizeChannelCreateParams(rawParams: unknown): ChannelCreateParams {
  const params = recordParams(rawParams);
  const name = requiredToolString(params, 'name', MAX_CHANNEL_NAME_LENGTH, normalizeTitle);
  const openingMessage = optionalToolString(params.opening_message, MAX_CHANNEL_SEED_LENGTH, normalizeTitle);
  return {
    name,
    memberRefs: uniqueStrings([
      ...uniqueStringArray(params.member_agent_ids, 'member_agent_ids'),
      ...uniqueStringArray(params.member_names, 'member_names'),
    ]),
    ...(openingMessage ? { openingMessage } : {}),
  };
}

function normalizeChannelUpdateParams(rawParams: unknown): ChannelUpdateParams {
  const params = recordParams(rawParams);
  const name = optionalToolString(params.name, MAX_CHANNEL_NAME_LENGTH, normalizeTitle);
  const addMemberRefs = uniqueStrings([
    ...uniqueStringArray(params.add_member_agent_ids, 'add_member_agent_ids'),
    ...uniqueStringArray(params.add_member_names, 'add_member_names'),
  ]);
  const removeMemberRefs = uniqueStrings([
    ...uniqueStringArray(params.remove_member_agent_ids, 'remove_member_agent_ids'),
    ...uniqueStringArray(params.remove_member_names, 'remove_member_names'),
  ]);
  if (!name && addMemberRefs.length === 0 && removeMemberRefs.length === 0) {
    throw new Error('Pass name, add_member_agent_ids/add_member_names, or remove_member_agent_ids/remove_member_names.');
  }
  const conversationId = optionalToolString(params.conversation_id, 240, normalizeTitle);
  const channelName = optionalToolString(params.channel_name, MAX_CHANNEL_NAME_LENGTH, normalizeTitle);
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(name ? { name } : {}),
    addMemberRefs,
    removeMemberRefs,
  };
}

function resolveAgentRefs(
  definitions: readonly AgentDefinitionView[],
  refs: readonly string[],
  field: string,
): string[] {
  if (refs.length === 0) return [];
  const result: string[] = [];
  for (const ref of refs) {
    const exact = definitions.find((definition) => definition.agentId === ref);
    const agentId = exact?.agentId ?? resolveAgentRefFromNames(definitions, ref, field);
    if (!result.includes(agentId)) result.push(agentId);
  }
  return result;
}

function resolveAgentRefFromNames(
  definitions: readonly AgentDefinitionView[],
  ref: string,
  field: string,
): string {
  const key = normalizeAgentRef(ref);
  if (!key) throw new Error(`Agent not found for ${field}: ${ref}`);
  const matches = ref.trim().startsWith('@')
    ? definitions.filter((definition) => agentMentionKey(definition) === key)
    : uniqueDefinitions([
        ...definitions.filter((definition) => agentNameKeys(definition).includes(key)),
        ...definitions.filter((definition) => agentMentionKey(definition) === key),
      ]);
  if (matches.length === 0) throw new Error(`Agent not found for ${field}: ${ref}`);
  if (matches.length > 1) throw new Error(`Agent reference "${ref}" is ambiguous. Pass an exact agent_id or @mention.`);
  return matches[0]!.agentId;
}

function agentNameKeys(definition: AgentDefinitionView): string[] {
  return uniqueStrings([
    definition.name,
    definition.displayName ?? '',
  ].map(normalizeAgentRef).filter(Boolean));
}

function agentMentionKey(definition: AgentDefinitionView): string {
  return normalizeAgentRef(agentMentionToken(definition.agentId));
}

function uniqueDefinitions(definitions: readonly AgentDefinitionView[]): AgentDefinitionView[] {
  const seen = new Set<string>();
  const result: AgentDefinitionView[] = [];
  for (const definition of definitions) {
    if (seen.has(definition.agentId)) continue;
    seen.add(definition.agentId);
    result.push(definition);
  }
  return result;
}

function channelRows(conversations: readonly AgentConversationListMeta[]): AgentConversationListMeta[] {
  return conversations.filter((conversation) => isEditableChannelRow(conversation) || conversation.id === DEFAULT_GENERAL_CHANNEL_ID);
}

function isEditableChannelRow(conversation: AgentConversationListMeta): boolean {
  return !conversation.canonicalDmAgentId && !!normalizeTitle(conversation.title);
}

function isMutableChannelRow(conversation: AgentConversationListMeta): boolean {
  return conversation.id !== DEFAULT_GENERAL_CHANNEL_ID && isEditableChannelRow(conversation);
}

function uniqueStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of agent references.`);
  if (value.length > MAX_MEMBER_EDITS) throw new Error(`${field} can contain at most ${MAX_MEMBER_EDITS} agent references.`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) throw new Error(`${field} must contain only non-empty strings.`);
    const agentId = item.trim();
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    result.push(agentId);
  }
  return result;
}

function normalizeTitle(title: string | null | undefined): string {
  return sanitizeConversationTitle(title) ?? '';
}

function normalizeAgentRef(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^@/, '').toLowerCase();
}

function channelToolResult(
  tool: string,
  data: ChannelToolData,
  started: number,
  instructions: string,
) {
  return agentToolResult(successEnvelope(tool, data, {
    instructions,
    metrics: { durationMs: Date.now() - started },
  }), visibleChannelData(data));
}

function channelToolError<TData = unknown>(
  tool: string,
  code: string,
  message: string,
  started: number,
) {
  return agentToolResult(errorEnvelope<TData>(tool, code, message, {
    instructions: 'Recover by asking the user for a Channel name, exact agent id, or by waiting until active Channel work finishes.',
    metrics: { durationMs: Date.now() - started },
  }));
}

function visibleChannelData(data: ChannelToolData) {
  return {
    conversation_id: data.conversation_id,
    name: data.name,
    members: data.members,
    ...(data.added_member_agent_ids ? { added_member_agent_ids: data.added_member_agent_ids } : {}),
    ...(data.removed_member_agent_ids ? { removed_member_agent_ids: data.removed_member_agent_ids } : {}),
    ...(data.renamed ? { renamed: true } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type AgentChannelToolEnvelope = ToolEnvelope<ChannelToolData>;
