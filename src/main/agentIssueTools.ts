import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentSessionReadInput,
  AgentSessionReadResult,
  AgentSessionSendMessageInput,
  AgentSessionStartInput,
  AgentSessionStopInput,
  IssueCreateInput,
  IssueReadInput,
  IssueReadResult,
  IssueSearchInput,
  IssueSearchResult,
  IssueUpdateInput,
  TenonAgentToolResult,
} from '../core/agentIssue';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import { AGENT_ISSUE_TOOL_DEFINITIONS } from './agentIssueToolDefinitions';

export interface AgentIssueToolRuntime {
  search(input: IssueSearchInput): Promise<IssueSearchResult> | IssueSearchResult;
  read(input: IssueReadInput): Promise<IssueReadResult> | IssueReadResult;
  create(input: IssueCreateInput): Promise<TenonAgentToolResult> | TenonAgentToolResult;
  update(input: IssueUpdateInput): Promise<TenonAgentToolResult> | TenonAgentToolResult;
  startSession(input: AgentSessionStartInput): Promise<TenonAgentToolResult> | TenonAgentToolResult;
  readSession(input: AgentSessionReadInput): Promise<AgentSessionReadResult | null> | AgentSessionReadResult | null;
  sendSessionMessage(input: AgentSessionSendMessageInput): Promise<TenonAgentToolResult> | TenonAgentToolResult;
  stopSession(input: AgentSessionStopInput): Promise<TenonAgentToolResult> | TenonAgentToolResult;
}

type AgentIssueToolData =
  | IssueSearchResult
  | IssueReadResult
  | AgentSessionReadResult
  | TenonAgentToolResult;

export function createAgentIssueTools(runtime: AgentIssueToolRuntime): AgentTool<any, ToolEnvelope<AgentIssueToolData>>[] {
  return AGENT_ISSUE_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    label: labelForTool(definition.name),
    description: definition.description({}, {
      actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
      permissionMode: 'interactive',
      isNonInteractiveSession: false,
    }),
    parameters: definition.inputSchema,
    executionMode: definition.kind === 'read' ? 'parallel' : 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      try {
        const data = await executeAgentIssueTool(runtime, definition.name, rawParams);
        return agentToolResult(successEnvelope(definition.name, data), modelVisibleData(data));
      } catch (error) {
        return agentToolResult(errorEnvelope(definition.name, 'agent_issue_tool_failed', errorMessage(error)));
      }
    },
  }));
}

async function executeAgentIssueTool(
  runtime: AgentIssueToolRuntime,
  name: string,
  rawParams: unknown,
): Promise<AgentIssueToolData> {
  switch (name) {
    case 'issue_search':
      return runtime.search(rawParams as IssueSearchInput);
    case 'issue_read':
      return runtime.read(rawParams as IssueReadInput);
    case 'issue_create':
      return runtime.create(rawParams as IssueCreateInput);
    case 'issue_update':
      return runtime.update(rawParams as IssueUpdateInput);
    case 'agent_session_start':
      return runtime.startSession(rawParams as AgentSessionStartInput);
    case 'agent_session_read': {
      const result = await runtime.readSession(rawParams as AgentSessionReadInput);
      if (!result) throw new Error('Agent Session was not found.');
      return result;
    }
    case 'agent_session_send_message':
      return runtime.sendSessionMessage(rawParams as AgentSessionSendMessageInput);
    case 'agent_session_stop':
      return runtime.stopSession(rawParams as AgentSessionStopInput);
    default:
      throw new Error(`Unknown agent issue tool: ${name}`);
  }
}

function labelForTool(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function modelVisibleData(data: AgentIssueToolData): string {
  return JSON.stringify(data);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
