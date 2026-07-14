import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentIssue,
  AgentRecurringIssue,
  AgentSession,
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
        return agentToolResult(
          successEnvelope(definition.name, data),
          modelVisibleData(definition.name, data, rawParams),
        );
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

function modelVisibleData(name: string, data: AgentIssueToolData, rawParams: unknown): string {
  if (name === 'issue_read') {
    return JSON.stringify(modelVisibleIssueRead(data as IssueReadResult));
  }
  if (name === 'agent_session_read') {
    return JSON.stringify(modelVisibleSessionRead(
      data as AgentSessionReadResult,
      rawParams as AgentSessionReadInput,
    ));
  }
  return JSON.stringify(data);
}

function modelVisibleIssueRead(result: IssueReadResult): unknown {
  return {
    target: result.target,
    ...(result.issue ? { issue: modelVisibleIssue(result.issue) } : {}),
    ...(result.recurringIssue ? { recurringIssue: modelVisibleRecurringIssue(result.recurringIssue) } : {}),
    ...(result.activity ? { activity: result.activity } : {}),
    ...(result.sessions ? { sessions: result.sessions.map(modelVisibleSessionSummary) } : {}),
    ...(result.childIssues ? { childIssues: result.childIssues.map(modelVisibleIssue) } : {}),
    ...(result.generatedIssues ? { generatedIssues: result.generatedIssues.map(modelVisibleIssue) } : {}),
  };
}

function modelVisibleIssue(issue: AgentIssue): Omit<AgentIssue, 'origin'> {
  const { origin: _origin, ...visible } = issue;
  return visible;
}

function modelVisibleRecurringIssue(
  recurringIssue: AgentRecurringIssue,
): Omit<AgentRecurringIssue, 'origin'> {
  const { origin: _origin, ...visible } = recurringIssue;
  return visible;
}

function modelVisibleSessionRead(
  result: AgentSessionReadResult,
  input: AgentSessionReadInput,
): unknown {
  const activity = result.activity ?? [];
  return {
    agentSession: {
      ...modelVisibleSessionSummary(result.agentSession),
      ...(input.include?.includes('latest-output') && result.agentSession.latestOutput !== undefined
        ? { latestOutput: result.agentSession.latestOutput }
        : {}),
    },
    ...(input.include?.includes('activity-summary')
      ? { activity: activity.slice(-20) }
      : {}),
  };
}

function modelVisibleSessionSummary(session: AgentSession): Record<string, unknown> {
  return {
    id: session.id,
    issueId: session.issueId,
    delegate: session.delegate,
    ...(session.purpose ? { purpose: session.purpose } : {}),
    state: session.state,
    ...(session.continuationOfAgentSessionId
      ? { continuationOfAgentSessionId: session.continuationOfAgentSessionId }
      : {}),
    ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
    ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
    ...(session.completedAt !== undefined ? { completedAt: session.completedAt } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    revision: session.revision,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
