import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentConversation, AgentConversationListMeta, AgentCreateConversationOptions } from '../core/types';
import type { AgentDefinitionView } from '../core/agentTypes';
import { DEFAULT_GENERAL_CHANNEL_ID, agentMentionToken } from '../core/agentChannel';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

export interface AgentChannelToolRuntime {
  currentConversationId(): string;
  createConversation(options: AgentCreateConversationOptions): Promise<AgentConversation>;
  listConversations(): Promise<AgentConversationListMeta[]>;
  listAllAgentDefinitions(conversationId: string): Promise<AgentDefinitionView[]>;
  renameConversation(conversationId: string, title: string): Promise<AgentConversationListMeta | null>;
  addConversationMember(conversationId: string, agentId: string): Promise<AgentConversation>;
  removeConversationMember(conversationId: string, agentId: string): Promise<AgentConversation>;
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
          const memberAgentIds = await resolveAgentRefs(
            runtime,
            runtime.currentConversationId(),
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
            await summarizeChannel(runtime, created.conversationId),
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
          const conversationId = await resolveChannelTarget(runtime, params);
          const addMemberAgentIds = await resolveAgentRefs(runtime, conversationId, params.addMemberRefs, 'add member reference');
          const removeMemberAgentIds = await resolveAgentRefs(runtime, conversationId, params.removeMemberRefs, 'remove member reference');
          const overlap = addMemberAgentIds.find((agentId) => removeMemberAgentIds.includes(agentId));
          if (overlap) throw new Error(`Agent ${overlap} cannot be both added and removed in one update.`);
          let renamed = false;
          if (params.name) {
            await runtime.renameConversation(conversationId, params.name);
            renamed = true;
          }
          for (const agentId of addMemberAgentIds) {
            await runtime.addConversationMember(conversationId, agentId);
          }
          for (const agentId of removeMemberAgentIds) {
            await runtime.removeConversationMember(conversationId, agentId);
          }
          return channelToolResult(
            CHANNEL_UPDATE_TOOL,
            {
              ...(await summarizeChannel(runtime, conversationId)),
              ...(renamed ? { renamed: true } : {}),
              ...(addMemberAgentIds.length > 0 ? { added_member_agent_ids: addMemberAgentIds } : {}),
              ...(removeMemberAgentIds.length > 0 ? { removed_member_agent_ids: removeMemberAgentIds } : {}),
            },
            started,
            'Summarize the Channel changes. If a requested member was missing or ambiguous, ask the user to clarify instead of guessing.',
          );
        } catch (error) {
          return channelToolError(CHANNEL_UPDATE_TOOL, 'CHANNEL_UPDATE_FAILED', errorMessage(error), started);
        }
      },
    },
  ];
}

async function resolveChannelTarget(
  runtime: AgentChannelToolRuntime,
  params: ChannelUpdateParams,
): Promise<string> {
  if (params.conversationId && params.channelName) {
    throw new Error('Pass either conversation_id or channel_name, not both.');
  }
  if (params.conversationId) return params.conversationId;

  const conversations = await runtime.listConversations();
  if (params.channelName) {
    const normalized = normalizeTitle(params.channelName);
    const matches = channelRows(conversations).filter((conversation) => normalizeTitle(conversation.title) === normalized);
    if (matches.length === 0) throw new Error(`No Channel named "${params.channelName}" was found.`);
    if (matches.length > 1) throw new Error(`More than one Channel is named "${params.channelName}". Pass conversation_id.`);
    if (!isMutableChannelRow(matches[0]!)) throw new Error('#General and DMs cannot be edited.');
    return matches[0]!.id;
  }

  const currentConversationId = runtime.currentConversationId();
  const current = conversations.find((conversation) => conversation.id === currentConversationId);
  if (!current || !isMutableChannelRow(current)) {
    throw new Error('The current conversation is not an editable Channel. Pass conversation_id or channel_name.');
  }
  return current.id;
}

async function summarizeChannel(
  runtime: AgentChannelToolRuntime,
  conversationId: string,
): Promise<ChannelToolData> {
  const [conversations, definitions] = await Promise.all([
    runtime.listConversations(),
    runtime.listAllAgentDefinitions(conversationId),
  ]);
  const conversation = conversations.find((candidate) => candidate.id === conversationId);
  if (!conversation) throw new Error(`Channel not found after update: ${conversationId}`);
  const definitionsById = new Map(definitions.map((definition) => [definition.agentId, definition]));
  return {
    conversation_id: conversationId,
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
  const name = requiredString(params, 'name', MAX_CHANNEL_NAME_LENGTH);
  const openingMessage = optionalString(params.opening_message, MAX_CHANNEL_SEED_LENGTH);
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
  const name = optionalString(params.name, MAX_CHANNEL_NAME_LENGTH);
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
  const conversationId = optionalString(params.conversation_id, 240);
  const channelName = optionalString(params.channel_name, MAX_CHANNEL_NAME_LENGTH);
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(name ? { name } : {}),
    addMemberRefs,
    removeMemberRefs,
  };
}

async function resolveAgentRefs(
  runtime: AgentChannelToolRuntime,
  conversationId: string,
  refs: readonly string[],
  field: string,
): Promise<string[]> {
  if (refs.length === 0) return [];
  const definitions = await runtime.listAllAgentDefinitions(conversationId);
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
  const matches = definitions.filter((definition) => agentRefKeys(definition).includes(key));
  if (matches.length === 0) throw new Error(`Agent not found for ${field}: ${ref}`);
  if (matches.length > 1) throw new Error(`Agent reference "${ref}" is ambiguous. Pass an exact agent_id.`);
  return matches[0]!.agentId;
}

function agentRefKeys(definition: AgentDefinitionView): string[] {
  return uniqueStrings([
    definition.name,
    definition.displayName ?? '',
    agentMentionToken(definition.agentId),
    `@${agentMentionToken(definition.agentId)}`,
  ].map(normalizeAgentRef).filter(Boolean));
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

function recordParams(rawParams: unknown): Record<string, unknown> {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    throw new Error('Tool input must be an object.');
  }
  return rawParams as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, field: string, maxLength: number): string {
  const value = optionalString(params[field], maxLength);
  if (!value) throw new Error(`Pass ${field}.`);
  return value;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = normalizeTitle(value);
  if (!normalized) return undefined;
  if (normalized.length > maxLength) throw new Error(`Value is too long; max ${maxLength} characters.`);
  return normalized;
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

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim();
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
