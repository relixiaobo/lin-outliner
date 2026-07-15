import type { AgentRunDetailPayload, AgentRunTranscriptPayload } from './agentTypes';

export type AgentIssueId = string;
export type AgentRecurringIssueId = string;
export type AgentSessionId = string;
export type ActivityId = string;
export type ObjectRevisionValue = string;

export type ActorRef =
  | { type: 'user'; userId: string }
  | { type: 'agent'; agentId: string }
  | { type: 'system' };

export const AGENT_ISSUE_RUN_PROFILES = ['default', 'background', 'verifier'] as const;
export type AgentIssueRunProfile = typeof AGENT_ISSUE_RUN_PROFILES[number];

export type AgentRef = {
  type: 'default-agent';
  runProfile?: AgentIssueRunProfile;
};

export type IssueStatusCategory =
  | 'triage'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

export interface IssueStatus {
  id?: string;
  name: string;
  category: IssueStatusCategory;
}

export type IssueViewBucket =
  | IssueStatusCategory
  | 'blocked'
  | 'attention-needed'
  | 'archived'
  | 'scheduled';

export type IssueRelation =
  | { type: 'blocked-by'; issueId: AgentIssueId }
  | { type: 'blocks'; issueId: AgentIssueId }
  | { type: 'related'; issueId: AgentIssueId }
  | { type: 'duplicate-of'; issueId: AgentIssueId };

export type IssueTrigger =
  | { type: 'when-ready' }
  | { type: 'scheduled'; startAt: number; timeZone: string };

export interface IssueDueDate {
  targetAt: number;
  timeZone?: string;
}

export interface IssueRecurrenceContext {
  recurringIssueId: AgentRecurringIssueId;
  windowStartAt: number;
  windowEndAt: number;
  materializedAt: number;
  timeZone?: string;
  skippedWindowCount?: number;
}

export interface IssueCompletionCriterion {
  id: string;
  text: string;
  state: 'open' | 'met' | 'waived';
  evidence?: IssueEvidenceRef[];
}

export interface IssueVerificationPolicy {
  mode: 'none' | 'criteria-and-evidence' | 'agent-review' | 'human-review';
  verifier?: AgentRef;
  requiredVerdict?: 'pass' | 'pass-or-partial';
  requiredEvidence?: string[];
}

export type IssueEvidenceRef =
  | { type: 'issue'; issueId: AgentIssueId }
  | { type: 'agent-session'; agentSessionId: AgentSessionId }
  | { type: 'activity'; activityId: ActivityId }
  | { type: 'node'; nodeId: string }
  | { type: 'file'; path: string }
  | { type: 'url'; url: string; label?: string };

export interface IssueConfirmation {
  confirmedBy: ActorRef;
  confirmedAt: number;
}

export type IssueInputScope =
  | { type: 'none' }
  | { type: 'selected-nodes'; nodeIds: string[] }
  | { type: 'node-children'; nodeId: string; depth?: number }
  | { type: 'tag-query'; tag: string; includeArchived?: boolean }
  | { type: 'saved-query'; queryId: string };

export type IssueOutputPolicy =
  | { type: 'activity-only' }
  | { type: 'daily-note'; datePolicy: 'session-date' | 'due-date' }
  | { type: 'append-to-node'; nodeId: string }
  | { type: 'create-child-under-node'; nodeId: string }
  | { type: 'per-input-child'; parentNodeId: string }
  | { type: 'replace-input'; requiresConfirmation: true };

export interface AgentExecutionPolicy {
  deadlineAt: number;
}

export type IssuePermissionMode = 'attended' | 'unattended';

export type AgentVisibleConversationOrigin = {
  type: 'conversation';
  conversationId: string;
};

export type AgentIssueOrigin =
  | AgentVisibleConversationOrigin
  | { type: 'agent-session'; agentSessionId: AgentSessionId };

export type AgentRecurringIssueOrigin = AgentVisibleConversationOrigin;

export interface AgentIssue {
  id: AgentIssueId;
  parentIssueId?: AgentIssueId;
  title: string;
  description?: string;
  status: IssueStatus;
  delegate?: AgentRef;
  relations: IssueRelation[];
  trigger: IssueTrigger;
  dueDate?: IssueDueDate;
  recurrence?: IssueRecurrenceContext;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  evidence?: IssueEvidenceRef[];
  noteNodeIds?: string[];
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode: IssuePermissionMode;
  executionPolicy?: AgentExecutionPolicy;
  confirmation: IssueConfirmation;
  origin?: AgentIssueOrigin;
  revision: ObjectRevisionValue;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  archivedAt?: number;
}

export type RecurringIssueCadence =
  | { type: 'daily'; time: string }
  | { type: 'weekly'; weekdays: number[]; time: string }
  | { type: 'monthly'; dayOfMonth: number; time: string };

export type RecurringCadenceType = RecurringIssueCadence['type'];

export type RecurringIssueMissedPolicy =
  | { type: 'coalesce-latest' }
  | { type: 'skip-missed' };

export interface RecurringIssueTemplate {
  delegate?: AgentRef;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode: IssuePermissionMode;
}

export interface AgentRecurringIssue {
  id: AgentRecurringIssueId;
  origin?: AgentRecurringIssueOrigin;
  titleTemplate: string;
  descriptionTemplate?: string;
  status: 'active' | 'paused' | 'archived';
  cadence: RecurringIssueCadence;
  timeZone: string;
  missedPolicy: RecurringIssueMissedPolicy;
  issueTemplate: RecurringIssueTemplate;
  confirmation: IssueConfirmation;
  nextMaterializationAt?: number;
  skippedMaterializationAts?: number[];
  revision: ObjectRevisionValue;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export type AgentSessionState =
  | 'pending'
  | 'active'
  | 'error'
  | 'complete'
  | 'stale'
  | 'canceled';

export function isActiveAgentSessionState(state: AgentSessionState): boolean {
  return state === 'pending' || state === 'active';
}

export type AgentSessionPurpose = 'execute' | 'verify';

export type AgentSessionSource =
  | { type: 'delegation'; actor: ActorRef }
  | { type: 'recurring-issue'; recurringIssueId: AgentRecurringIssueId; dueAt: number }
  | { type: 'runtime-action'; actor: ActorRef }
  | { type: 'orchestration'; coordinatorAgentSessionId: AgentSessionId }
  | { type: 'manual'; actor: ActorRef };

export interface ResolvedIssueInput {
  scope: IssueInputScope;
  resolvedAt: number;
  nodeIds?: string[];
  preview?: string;
}

export interface AgentSession {
  id: AgentSessionId;
  issueId: AgentIssueId;
  delegate: AgentRef;
  purpose?: AgentSessionPurpose;
  state: AgentSessionState;
  source: AgentSessionSource;
  issueSnapshot: AgentIssue;
  inputSnapshot?: ResolvedIssueInput;
  outputSnapshot?: IssueOutputPolicy;
  executionPolicy?: AgentExecutionPolicy;
  continuationOfAgentSessionId?: AgentSessionId;
  latestOutput?: string;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  revision: ObjectRevisionValue;
  createdAt: number;
  updatedAt: number;
}

export type ActivityTarget =
  | { type: 'issue'; issueId: AgentIssueId }
  | { type: 'recurring-issue'; recurringIssueId: AgentRecurringIssueId }
  | { type: 'agent-session'; agentSessionId: AgentSessionId };

export type ActivityContent =
  | { type: 'created' }
  | { type: 'updated'; fields?: string[] }
  | { type: 'archived' }
  | { type: 'deleted' }
  | { type: 'comment'; body: string }
  | { type: 'field-change'; field: string; from?: unknown; to?: unknown }
  | { type: 'status-change'; from?: string; to: string }
  | { type: 'agent-progress'; body: string }
  | { type: 'agent-question'; body: string }
  | { type: 'agent-action'; action: string; parameter?: string; result?: string }
  | { type: 'agent-response'; body: string }
  | { type: 'agent-error'; body: string }
  | {
      type: 'verification-result';
      verdict: 'pass' | 'fail' | 'partial';
      body: string;
      agentSessionId?: AgentSessionId;
    }
  | { type: 'output-link'; nodeId?: string; url?: string; label: string };

export interface ActivitySignal {
  type: string;
  value?: string | number | boolean;
}

export type RelatedTargetRef =
  | { type: 'issue'; id: AgentIssueId }
  | { type: 'recurring-issue'; id: AgentRecurringIssueId }
  | { type: 'agent-session'; id: AgentSessionId }
  | { type: 'activity'; id: ActivityId };

export interface Activity {
  id: ActivityId;
  target: ActivityTarget;
  actor: ActorRef;
  content: ActivityContent;
  signals?: ActivitySignal[];
  relatedTargets?: RelatedTargetRef[];
  createdAt: number;
}

const GENERIC_AGENT_SESSION_PROGRESS_BODIES = new Set([
  'Agent Session created and waiting for runtime execution.',
  'Agent Session execution started.',
  'Agent Session is active.',
  'Agent Session is pending.',
  'Agent Session completed.',
]);

export function isUserVisibleIssueActivity(activity: Pick<Activity, 'content'>): boolean {
  switch (activity.content.type) {
    case 'created':
    case 'updated':
    case 'archived':
    case 'deleted':
    case 'comment':
    case 'agent-action':
    case 'agent-question':
    case 'agent-error':
    case 'verification-result':
    case 'output-link':
    case 'status-change':
      return true;
    case 'agent-progress':
      return !GENERIC_AGENT_SESSION_PROGRESS_BODIES.has(activity.content.body);
    case 'agent-response':
    case 'field-change':
      return false;
  }
}

export function isUserVisibleSessionProcessActivity(activity: Pick<Activity, 'content'>): boolean {
  switch (activity.content.type) {
    case 'agent-progress':
      return !GENERIC_AGENT_SESSION_PROGRESS_BODIES.has(activity.content.body);
    case 'agent-question':
    case 'verification-result':
    case 'agent-error':
      return true;
    case 'comment':
    case 'created':
    case 'updated':
    case 'archived':
    case 'deleted':
    case 'agent-action':
    case 'agent-response':
    case 'field-change':
    case 'output-link':
    case 'status-change':
      return false;
  }
}

export interface ValidationMessage {
  path?: string;
  code: string;
  message: string;
}

export interface PermissionBlock {
  code: string;
  message: string;
}

export interface ObjectRevision {
  target: RelatedTargetRef;
  revision: ObjectRevisionValue;
}

export type ChangeRequest =
  | { mode: 'preview' }
  | { mode: 'request' };

export interface TenonAgentToolResult {
  status: 'preview' | 'applied' | 'blocked' | 'conflict';
  targets: RelatedTargetRef[];
  revisions?: ObjectRevision[];
  validation?: ValidationMessage[];
  warnings?: ValidationMessage[];
  permissionBlock?: PermissionBlock;
}

export interface TenonAgentToolContext {
  actor: ActorRef;
  coordinatorAgentSessionId?: AgentSessionId;
  permissionMode: 'interactive' | 'non-interactive';
  now: number;
}

export interface TenonAgentToolDescriptionContext {
  actor: ActorRef;
  permissionMode: 'interactive' | 'non-interactive';
  isNonInteractiveSession: boolean;
}

export interface TenonAgentToolPromptContext {
  actor: ActorRef;
  permissionMode: 'interactive' | 'non-interactive';
  availableRunProfiles: AgentRef[];
}

export interface ValidationResult {
  ok: boolean;
  messages?: ValidationMessage[];
}

export type TenonAgentToolKind = 'read' | 'mutation' | 'runtime-control';

export type AgentIssueToolName =
  | 'issue_search'
  | 'issue_read'
  | 'issue_create'
  | 'issue_update'
  | 'agent_session_start'
  | 'agent_session_read'
  | 'agent_session_send_message'
  | 'agent_session_stop';

export interface TenonAgentToolDefinition<Input = unknown, Output = unknown> {
  name: AgentIssueToolName;
  kind: TenonAgentToolKind;
  searchHint: string;
  description(input: unknown, context: TenonAgentToolDescriptionContext): string;
  promptGuidance(context: TenonAgentToolPromptContext): string;
  inputSchema: unknown;
  outputSchema: unknown;
  isReadOnly(input: unknown): boolean;
  isDestructive(input: unknown): boolean;
  validate(input: unknown, context: TenonAgentToolContext): ValidationResult;
  execute(input: Input, context: TenonAgentToolContext): Output | Promise<Output>;
}

export type IssueSearchTarget = 'issue' | 'recurring-issue';

export interface TimeRangeFilter {
  from?: number;
  to?: number;
}

export interface IssueSearchOrder {
  field: 'createdAt' | 'updatedAt' | 'dueDate' | 'nextMaterializationAt' | 'status';
  direction?: 'asc' | 'desc';
}

export type IssueSearchInclude =
  | 'activity-summary'
  | 'session-summary';

export interface IssueSearchFilter {
  ids?: string[];
  statusCategories?: IssueViewBucket[];
  delegateIds?: string[];
  issueIds?: AgentIssueId[];
  recurringIssueIds?: AgentRecurringIssueId[];
  parentIssueIds?: AgentIssueId[];
  hasParentIssue?: boolean;
  triggerTypes?: IssueTrigger['type'][];
  dueDate?: TimeRangeFilter;
  cadence?: RecurringCadenceType[];
  nextMaterializationAt?: TimeRangeFilter;
  relation?: {
    type: IssueRelation['type'];
    issueId?: AgentIssueId;
  };
  archived?: boolean;
  hasActiveSession?: boolean;
  needsAttention?: boolean;
  inputNodeIds?: string[];
  inputTags?: string[];
  sessionState?: AgentSessionState[];
  activityTypes?: ActivityContent['type'][];
  activityTarget?: ActivityTarget;
  createdAt?: TimeRangeFilter;
  updatedAt?: TimeRangeFilter;
  terminalAt?: TimeRangeFilter;
}

export interface IssueSearchInput {
  targets?: IssueSearchTarget[];
  text?: string;
  filter?: IssueSearchFilter;
  include?: IssueSearchInclude[];
  orderBy?: IssueSearchOrder[];
  limit?: number;
  cursor?: string;
}

export type IssueTargetRef =
  | { type: 'issue'; id: AgentIssueId }
  | { type: 'recurring-issue'; id: AgentRecurringIssueId };

export type IssueReadInclude =
  | 'activity'
  | 'sessions'
  | 'child-issues'
  | 'generated-issues';

export interface IssueReadInput {
  target: IssueTargetRef;
  include?: IssueReadInclude[];
}

export interface IssueDraftFields {
  title: string;
  description?: string;
  delegate?: AgentRef;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  dueDate?: IssueDueDate;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  evidence?: IssueEvidenceRef[];
  noteNodeIds?: string[];
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode?: IssuePermissionMode;
  executionPolicy?: AgentExecutionPolicy;
}

export interface RecurringIssueDraftFields {
  titleTemplate: string;
  descriptionTemplate?: string;
  cadence: RecurringIssueCadence;
  timeZone: string;
  missedPolicy?: RecurringIssueMissedPolicy;
  issueTemplate: RecurringIssueTemplate;
}

export interface IssuePatchFields {
  title?: string;
  description?: string;
  delegate?: AgentRef;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  dueDate?: IssueDueDate | null;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  evidence?: IssueEvidenceRef[];
  noteNodeIds?: string[];
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode?: IssuePermissionMode;
  executionPolicy?: AgentExecutionPolicy;
}

export interface RecurringIssuePatchFields {
  titleTemplate?: string;
  descriptionTemplate?: string;
  cadence?: RecurringIssueCadence;
  timeZone?: string;
  missedPolicy?: RecurringIssueMissedPolicy;
  issueTemplate?: RecurringIssueTemplate;
}

export type IssueCreateInput =
  | {
      issueType: 'issue';
      fields: IssueDraftFields;
      request: ChangeRequest;
      reason: string;
    }
  | {
      issueType: 'recurring-issue';
      fields: RecurringIssueDraftFields;
      request: ChangeRequest;
      reason: string;
    };

export type IssueUpdateChange =
  | { type: 'patch'; patch: IssuePatchFields }
  | { type: 'transition'; status: IssueStatus }
  | { type: 'archive' }
  | { type: 'delete' };

export type RecurringIssueUpdateChange =
  | { type: 'patch'; patch: RecurringIssuePatchFields }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'skip-next' }
  | { type: 'archive' }
  | { type: 'delete' };

export type IssueUpdateInput =
  | {
      target: { type: 'issue'; id: AgentIssueId; expectedRevision?: ObjectRevisionValue };
      change: IssueUpdateChange;
      request: ChangeRequest;
      reason: string;
    }
  | {
      target: { type: 'recurring-issue'; id: AgentRecurringIssueId; expectedRevision?: ObjectRevisionValue };
      change: RecurringIssueUpdateChange;
      request: ChangeRequest;
      reason: string;
    };

export interface AgentSessionContinuationRequest {
  previousAgentSessionId: AgentSessionId;
  intent: 'continue' | 'retry' | 'revise';
  guidance?: string;
  context?: 'summary' | 'transcript' | 'none';
}

export interface AgentSessionExecutionPolicyOverride {
  deadlineAt?: number;
}

export interface AgentSessionStartInput {
  issueId: AgentIssueId;
  purpose?: AgentSessionPurpose;
  expectedIssueRevision?: ObjectRevisionValue;
  continuation?: AgentSessionContinuationRequest;
  detach?: boolean;
  executionPolicyOverride?: AgentSessionExecutionPolicyOverride;
  request: ChangeRequest;
  reason: string;
}

export type AgentSessionReadInclude =
  | 'activity-summary'
  | 'latest-output';

export interface AgentSessionReadInput {
  agentSessionId: AgentSessionId;
  wait?: boolean;
  timeoutMs?: number;
  include?: AgentSessionReadInclude[];
}

export interface AgentSessionSendMessageInput {
  agentSessionId: AgentSessionId;
  message: string;
  request: ChangeRequest;
  reason: string;
}

export interface AgentSessionStopInput {
  agentSessionId: AgentSessionId;
  request: ChangeRequest;
  reason: string;
}

export interface IssueSearchRow {
  target: IssueTargetRef;
  parentIssueId?: AgentIssueId;
  title: string;
  status: string;
  statusCategory?: IssueStatusCategory;
  viewBuckets?: IssueViewBucket[];
  trigger?: IssueTrigger;
  dueDate?: IssueDueDate;
  cadence?: RecurringIssueCadence;
  nextMaterializationAt?: number;
  hasActiveSession?: boolean;
  needsAttention?: boolean;
  latestSessionState?: AgentSessionState;
  latestSessionUpdatedAt?: number;
  revision: ObjectRevisionValue;
  updatedAt: number;
  terminalAt?: number;
  latestActivity?: Activity;
  activityCount?: number;
}

export interface IssueSearchResult {
  rows: IssueSearchRow[];
  nextCursor?: string;
}

export interface IssueReadResult {
  target: IssueTargetRef;
  issue?: AgentIssue;
  recurringIssue?: AgentRecurringIssue;
  activity?: Activity[];
  sessions?: AgentSession[];
  childIssues?: AgentIssue[];
  generatedIssues?: AgentIssue[];
}

export interface AgentSessionReadResult {
  agentSession: AgentSession;
  activity?: Activity[];
}

export interface AgentSessionTranscriptResult {
  agentSessionId: AgentSessionId;
  conversationId: string;
  runId: string;
  run: AgentRunDetailPayload;
  transcript: AgentRunTranscriptPayload;
}
