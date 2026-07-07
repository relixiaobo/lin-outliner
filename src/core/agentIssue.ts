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
  | 'backlog'
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
  | { type: 'manual' }
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

export type IssueConfirmation =
  | { state: 'draft' }
  | { state: 'confirmed'; confirmedBy: ActorRef; confirmedAt: number };

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
  retryPolicy: 'none' | 'manual' | 'bounded';
  maxAutomaticRetries?: number;
}

export type IssuePermissionMode = 'attended' | 'unattended';

export interface AgentIssue {
  id: AgentIssueId;
  title: string;
  description?: string;
  status: IssueStatus;
  delegate?: AgentRef;
  parentIssueId?: AgentIssueId;
  subIssueIds: AgentIssueId[];
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
  revision: ObjectRevisionValue;
  createdAt: number;
  updatedAt: number;
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
  parentIssueId?: AgentIssueId;
  relations?: IssueRelation[];
  trigger?: IssueTrigger;
  completionCriteria?: IssueCompletionCriterion[];
  verificationPolicy?: IssueVerificationPolicy;
  input?: IssueInputScope;
  output?: IssueOutputPolicy;
  permissionMode: IssuePermissionMode;
  executionPolicy?: AgentExecutionPolicy;
}

export interface AgentRecurringIssue {
  id: AgentRecurringIssueId;
  titleTemplate: string;
  descriptionTemplate?: string;
  status: 'active' | 'paused' | 'archived';
  cadence: RecurringIssueCadence;
  timeZone: string;
  missedPolicy: RecurringIssueMissedPolicy;
  issueTemplate: RecurringIssueTemplate;
  confirmation: IssueConfirmation;
  nextMaterializationAt?: number;
  revision: ObjectRevisionValue;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export type AgentSessionState =
  | 'pending'
  | 'active'
  | 'error'
  | 'awaitingInput'
  | 'complete'
  | 'stale'
  | 'canceled';

export type AgentSessionSource =
  | { type: 'delegation'; actor: ActorRef }
  | { type: 'recurring-issue'; recurringIssueId: AgentRecurringIssueId; dueAt: number }
  | { type: 'runtime-authorized-action'; actor: ActorRef }
  | { type: 'orchestration'; coordinatorAgentSessionId: AgentSessionId }
  | { type: 'manual'; actor: ActorRef };

export interface ResolvedIssueInput {
  scope: IssueInputScope;
  resolvedAt: number;
  nodeIds?: string[];
  preview?: string;
}

export interface AgentSessionPlanItem {
  content: string;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
}

export interface AgentSession {
  id: AgentSessionId;
  issueId: AgentIssueId;
  delegate: AgentRef;
  state: AgentSessionState;
  source: AgentSessionSource;
  issueSnapshot: AgentIssue;
  inputSnapshot?: ResolvedIssueInput;
  outputSnapshot?: IssueOutputPolicy;
  executionPolicy?: AgentExecutionPolicy;
  continuationOfAgentSessionId?: AgentSessionId;
  plan: AgentSessionPlanItem[];
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

export interface ValidationMessage {
  path?: string;
  code: string;
  message: string;
}

export interface PermissionBlock {
  code: string;
  message: string;
}

export interface ConfirmationProposal {
  title: string;
  body: string;
  operation: AgentOperationScope;
  targets: RelatedTargetRef[];
}

export interface ObjectRevision {
  target: RelatedTargetRef;
  revision: ObjectRevisionValue;
}

export type ChangeRequest =
  | { mode: 'preview' }
  | { mode: 'request' };

export interface TenonAgentToolResult {
  status: 'preview' | 'applied' | 'needs-confirmation' | 'blocked' | 'conflict';
  targets: RelatedTargetRef[];
  revisions?: ObjectRevision[];
  validation?: ValidationMessage[];
  warnings?: ValidationMessage[];
  permissionBlock?: PermissionBlock;
  confirmation?: ConfirmationProposal;
}

export interface RuntimeAuthorizationCapability {
  id: string;
  actor: ActorRef;
  allowedOperations: AgentOperationScope[];
  expiresAt: number;
  auditReason: string;
}

export type AgentOperationScope =
  | { type: 'issue-create' }
  | { type: 'issue-update'; issueId?: AgentIssueId }
  | { type: 'recurring-issue-update'; recurringIssueId?: AgentRecurringIssueId }
  | { type: 'agent-session-start'; issueId?: AgentIssueId }
  | { type: 'agent-session-message'; agentSessionId?: AgentSessionId }
  | { type: 'agent-session-stop'; agentSessionId?: AgentSessionId };

export interface TenonAgentToolContext {
  actor: ActorRef;
  authorization?: RuntimeAuthorizationCapability;
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
  requiresRuntimeAuthorization(input: unknown): boolean;
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
  | 'session-summary'
  | 'sub-issues-summary'
  | 'criteria-summary'
  | 'input-preview'
  | 'output-preview'
  | 'next-generated-issue';

export interface IssueSearchFilter {
  ids?: string[];
  statusCategories?: IssueViewBucket[];
  delegateIds?: string[];
  issueIds?: AgentIssueId[];
  recurringIssueIds?: AgentRecurringIssueId[];
  parentIssueIds?: AgentIssueId[];
  hasSubIssues?: boolean;
  triggerTypes?: IssueTrigger['type'][];
  dueDate?: TimeRangeFilter;
  cadence?: RecurringCadenceType[];
  nextMaterializationAt?: TimeRangeFilter;
  relation?: {
    type: IssueRelation['type'];
    issueId?: AgentIssueId;
  };
  confirmed?: boolean;
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
  | 'definition'
  | 'activity'
  | 'sessions'
  | 'sub-issues'
  | 'criteria'
  | 'progress'
  | 'generated-issues'
  | 'linked-notes'
  | 'input-preview'
  | 'output-preview'
  | 'session-plan';

export interface IssueReadInput {
  target: IssueTargetRef;
  include?: IssueReadInclude[];
}

export interface IssueDraftFields {
  title: string;
  description?: string;
  delegate?: AgentRef;
  parentIssueId?: AgentIssueId;
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
  status?: IssueStatus;
  delegate?: AgentRef;
  parentIssueId?: AgentIssueId | null;
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
  status?: AgentRecurringIssue['status'];
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
  | { type: 'confirm' }
  | { type: 'archive' }
  | { type: 'delete' };

export type RecurringIssueUpdateChange =
  | { type: 'patch'; patch: RecurringIssuePatchFields }
  | { type: 'confirm' }
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
  retryPolicy?: 'none' | 'manual' | 'bounded';
  maxAutomaticRetries?: number;
}

export interface AgentSessionStartInput {
  issueId: AgentIssueId;
  expectedIssueRevision?: ObjectRevisionValue;
  continuation?: AgentSessionContinuationRequest;
  detach?: boolean;
  executionPolicyOverride?: AgentSessionExecutionPolicyOverride;
  request: ChangeRequest;
  reason: string;
}

export type AgentSessionReadInclude =
  | 'activity-summary'
  | 'latest-output'
  | 'blocking-question';

export interface AgentSessionReadInput {
  agentSessionId: AgentSessionId;
  wait?: boolean;
  timeoutMs?: number;
  include?: AgentSessionReadInclude[];
}

export interface AgentSessionSendMessageInput {
  agentSessionId: AgentSessionId;
  message: string;
  kind?: 'guidance' | 'answer';
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
  title: string;
  status: string;
  revision: ObjectRevisionValue;
  updatedAt: number;
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
  subIssues?: AgentIssue[];
  generatedIssues?: AgentIssue[];
}

export interface AgentSessionReadResult {
  agentSession: AgentSession;
  activity?: Activity[];
}
