const REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  description: 'Preview or request mode for a mutation or runtime-control operation.',
  properties: {
    mode: {
      type: 'string',
      enum: ['preview', 'request'],
      description: 'Use preview to validate without persistence; use request to ask runtime to apply the operation under runtime-owned authorization.',
    },
  },
} as const;

const TIME_RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Inclusive/exclusive millisecond epoch range filter. Omit either side for an open-ended range.',
  properties: {
    from: { type: 'number', description: 'Lower bound in milliseconds since epoch.' },
    to: { type: 'number', description: 'Upper bound in milliseconds since epoch.' },
  },
} as const;

const TARGET_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id'],
  description: 'Durable object to address: a concrete Issue or a Recurring Issue definition.',
  properties: {
    type: {
      type: 'string',
      enum: ['issue', 'recurring-issue'],
      description: 'Target object family. Use issue for concrete work and recurring-issue for a cadence/template.',
    },
    id: {
      type: 'string',
      minLength: 1,
      description: 'Canonical object id returned by issue_search, issue_read, issue_create, or issue_update.',
    },
    expectedRevision: {
      type: 'string',
      minLength: 1,
      description: 'Optional last-seen revision. Include it after reading the object so stale updates return conflict.',
    },
  },
} as const;

const AGENT_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Neva execution profile assignment. V1 cannot express peers, personas, teams, or external agents.',
  properties: {
    type: {
      type: 'string',
      enum: ['default-agent'],
      description: 'The only V1 delegate kind: the built-in Neva agent.',
    },
    runProfile: {
      type: 'string',
      enum: ['default', 'background', 'verifier'],
      description: 'Optional Neva run profile for runtime policy. Omit for default execution.',
    },
  },
} as const;

const ISSUE_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'category'],
  description: 'Stored Issue lifecycle state. Derived buckets such as blocked or scheduled are search projections, not stored status categories.',
  properties: {
    id: { type: 'string', minLength: 1, description: 'Optional stable status id for future custom workflow support.' },
    name: { type: 'string', minLength: 1, description: 'Human-readable status name.' },
    category: {
      type: 'string',
      enum: ['triage', 'unstarted', 'started', 'completed', 'canceled'],
      description: 'Stored lifecycle category for the Issue.',
    },
  },
} as const;

const ISSUE_RELATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'issueId'],
  description: 'Visible relationship between Issues. Use this for dependencies instead of hidden workflow conditions.',
  properties: {
    type: {
      type: 'string',
      enum: ['blocked-by', 'blocks', 'related', 'duplicate-of'],
      description: 'Relationship kind between the current Issue and another Issue.',
    },
    issueId: { type: 'string', minLength: 1, description: 'Related concrete Issue id.' },
  },
} as const;

const ISSUE_TRIGGER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Execution trigger for a concrete Issue. Due dates are deadlines, not triggers.',
  properties: {
    type: {
      type: 'string',
      enum: ['manual', 'when-ready', 'scheduled'],
      description: 'manual never starts automatically; when-ready starts when unblocked and eligible; scheduled starts at startAt when eligible.',
    },
    startAt: {
      type: 'number',
      description: 'Millisecond epoch start time for a scheduled trigger. Required when type is scheduled.',
    },
    timeZone: {
      type: 'string',
      minLength: 1,
      description: 'IANA time zone for scheduled trigger interpretation. Required when type is scheduled.',
    },
  },
} as const;

const DUE_DATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['targetAt'],
  description: 'User-facing deadline or target date. It does not start execution.',
  properties: {
    targetAt: { type: 'number', description: 'Deadline or target date in milliseconds since epoch.' },
    timeZone: { type: 'string', minLength: 1, description: 'Optional IANA time zone for displaying the due date.' },
  },
} as const;

const EVIDENCE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Evidence link that supports Issue completion or verification.',
  properties: {
    type: {
      type: 'string',
      enum: ['issue', 'agent-session', 'activity', 'node', 'file', 'url'],
      description: 'Evidence target kind.',
    },
    issueId: { type: 'string', minLength: 1, description: 'Issue evidence id when type is issue.' },
    agentSessionId: { type: 'string', minLength: 1, description: 'Agent Session evidence id when type is agent-session.' },
    activityId: { type: 'string', minLength: 1, description: 'Activity evidence id when type is activity.' },
    nodeId: { type: 'string', minLength: 1, description: 'Outliner node evidence id when type is node.' },
    path: { type: 'string', minLength: 1, description: 'Local file path evidence when type is file.' },
    url: { type: 'string', minLength: 1, description: 'URL evidence when type is url.' },
    label: { type: 'string', minLength: 1, description: 'Optional display label for URL evidence.' },
  },
} as const;

const COMPLETION_CRITERION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text', 'state'],
  description: 'Observable completion criterion for a large or parent Issue.',
  properties: {
    id: { type: 'string', minLength: 1, description: 'Stable criterion id.' },
    text: { type: 'string', minLength: 1, description: 'Observable condition that can be met, waived, or left open.' },
    state: {
      type: 'string',
      enum: ['open', 'met', 'waived'],
      description: 'Criterion state.',
    },
    evidence: {
      type: 'array',
      items: EVIDENCE_REF_SCHEMA,
      description: 'Evidence links for this criterion.',
    },
  },
} as const;

const VERIFICATION_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  description: 'Completion gate for the Issue. Verification uses normal Agent Sessions and Activity, not a separate tool family.',
  properties: {
    mode: {
      type: 'string',
      enum: ['none', 'criteria-and-evidence', 'agent-review', 'human-review'],
      description: 'Verification mode required before completion.',
    },
    verifier: {
      ...AGENT_REF_SCHEMA,
      description: 'Neva verifier profile to use when mode is agent-review.',
    },
    requiredVerdict: {
      type: 'string',
      enum: ['pass', 'pass-or-partial'],
      description: 'Verifier verdict required for completion when mode is agent-review.',
    },
    requiredEvidence: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Evidence labels or requirements that must be present before completion.',
    },
  },
} as const;

const INPUT_SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Confirmed source-material scope available to Agent Sessions for this Issue.',
  properties: {
    type: {
      type: 'string',
      enum: ['none', 'selected-nodes', 'node-children', 'tag-query', 'saved-query'],
      description: 'Input source selection mode.',
    },
    nodeIds: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description: 'Node ids to process when type is selected-nodes.',
    },
    nodeId: {
      type: 'string',
      minLength: 1,
      description: 'Root node id when type is node-children.',
    },
    depth: {
      type: 'integer',
      minimum: 0,
      description: 'Descendant depth to include for node-children input.',
    },
    tag: {
      type: 'string',
      minLength: 1,
      description: 'Tag name or id to match when type is tag-query.',
    },
    includeArchived: {
      type: 'boolean',
      description: 'Whether archived content can be included in a tag-query input scope. Default false.',
    },
    queryId: {
      type: 'string',
      minLength: 1,
      description: 'Saved query id when type is saved-query.',
    },
  },
} as const;

const OUTPUT_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Confirmed output destination and write scope for Agent Sessions on this Issue.',
  properties: {
    type: {
      type: 'string',
      enum: ['activity-only', 'daily-note', 'append-to-node', 'create-child-under-node', 'per-input-child', 'replace-input'],
      description: 'Output destination mode. Defaults should be activity-only unless the user or Issue scope clearly names a write target.',
    },
    datePolicy: {
      type: 'string',
      enum: ['session-date', 'due-date'],
      description: 'Daily note date policy when type is daily-note.',
    },
    nodeId: {
      type: 'string',
      minLength: 1,
      description: 'Output node id for append-to-node or create-child-under-node.',
    },
    parentNodeId: {
      type: 'string',
      minLength: 1,
      description: 'Parent node id for per-input-child output.',
    },
    requiresConfirmation: {
      type: 'boolean',
      description: 'Must be true for replace-input output because it can overwrite source material.',
    },
  },
} as const;

const EXECUTION_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deadlineAt', 'retryPolicy'],
  description: 'Execution limits and retry behavior for Agent Sessions created from this Issue.',
  properties: {
    deadlineAt: { type: 'number', description: 'Execution deadline in milliseconds since epoch.' },
    retryPolicy: {
      type: 'string',
      enum: ['none', 'manual', 'bounded'],
      description: 'Retry policy for failed Sessions.',
    },
    maxAutomaticRetries: {
      type: 'integer',
      minimum: 0,
      description: 'Maximum automatic retries when retryPolicy is bounded.',
    },
  },
} as const;

const ISSUE_FIELDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Durable fields for a concrete Issue. Required on create: title. Other fields default to manual, attended local work, and unstarted-like lifecycle.',
  properties: {
    title: { type: 'string', minLength: 1, description: 'Specific human-readable Issue name.' },
    description: { type: 'string', description: 'Stable goal, context, constraints, and acceptance guidance.' },
    status: ISSUE_STATUS_SCHEMA,
    delegate: AGENT_REF_SCHEMA,
    parentIssueId: { type: 'string', minLength: 1, description: 'Parent Issue id for visible sub-issue breakdown.' },
    relations: { type: 'array', items: ISSUE_RELATION_SCHEMA, description: 'Visible dependency and relationship links.' },
    trigger: ISSUE_TRIGGER_SCHEMA,
    dueDate: DUE_DATE_SCHEMA,
    completionCriteria: { type: 'array', items: COMPLETION_CRITERION_SCHEMA, description: 'Observable completion criteria.' },
    verificationPolicy: VERIFICATION_POLICY_SCHEMA,
    evidence: { type: 'array', items: EVIDENCE_REF_SCHEMA, description: 'Evidence links attached to the Issue.' },
    noteNodeIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Outliner note nodes attached as durable context.' },
    input: INPUT_SCOPE_SCHEMA,
    output: OUTPUT_POLICY_SCHEMA,
    permissionMode: {
      type: 'string',
      enum: ['attended', 'unattended'],
      description: 'Execution permission mode. Use unattended only when the Issue scope allows background execution.',
    },
    executionPolicy: EXECUTION_POLICY_SCHEMA,
  },
} as const;

const CADENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Calendar cadence for a Recurring Issue. V1 supports daily, weekly, and monthly schedules.',
  properties: {
    type: {
      type: 'string',
      enum: ['daily', 'weekly', 'monthly'],
      description: 'Cadence type.',
    },
    time: {
      type: 'string',
      minLength: 1,
      description: 'Local time in HH:mm form for daily, weekly, or monthly cadence.',
    },
    weekdays: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 },
      description: 'Weekday numbers for weekly cadence, where 0 is Sunday.',
    },
    dayOfMonth: {
      type: 'integer',
      minimum: 1,
      maximum: 31,
      description: 'Calendar day for monthly cadence.',
    },
  },
} as const;

const MISSED_POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  description: 'Policy for due windows missed while the app was offline or unable to materialize work.',
  properties: {
    type: {
      type: 'string',
      enum: ['coalesce-latest', 'skip-missed'],
      description: 'coalesce-latest creates one latest concrete Issue; skip-missed records skipped windows without creating stale Issues.',
    },
  },
} as const;

const RECURRING_TEMPLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['permissionMode'],
  description: 'Issue template copied into each concrete Issue generated by the Recurring Issue.',
  properties: {
    delegate: AGENT_REF_SCHEMA,
    parentIssueId: { type: 'string', minLength: 1, description: 'Parent Issue id assigned to generated Issues.' },
    relations: { type: 'array', items: ISSUE_RELATION_SCHEMA, description: 'Relations copied to generated Issues.' },
    trigger: ISSUE_TRIGGER_SCHEMA,
    completionCriteria: { type: 'array', items: COMPLETION_CRITERION_SCHEMA, description: 'Criteria copied to generated Issues.' },
    verificationPolicy: VERIFICATION_POLICY_SCHEMA,
    input: INPUT_SCOPE_SCHEMA,
    output: OUTPUT_POLICY_SCHEMA,
    permissionMode: {
      type: 'string',
      enum: ['attended', 'unattended'],
      description: 'Execution permission mode copied to generated Issues.',
    },
    executionPolicy: EXECUTION_POLICY_SCHEMA,
  },
} as const;

const RECURRING_FIELDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Durable fields for a Recurring Issue. Required on create: titleTemplate, cadence, timeZone, and issueTemplate.',
  properties: {
    titleTemplate: { type: 'string', minLength: 1, description: 'Template for generated concrete Issue titles.' },
    descriptionTemplate: { type: 'string', description: 'Template for generated Issue descriptions.' },
    status: {
      type: 'string',
      enum: ['active', 'paused', 'archived'],
      description: 'Recurring Issue lifecycle. Confirmation provenance is stored separately from this status.',
    },
    cadence: CADENCE_SCHEMA,
    timeZone: { type: 'string', minLength: 1, description: 'IANA time zone used to interpret cadence times.' },
    missedPolicy: MISSED_POLICY_SCHEMA,
    issueTemplate: RECURRING_TEMPLATE_SCHEMA,
  },
} as const;

export const ISSUE_SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    targets: {
      type: 'array',
      items: { type: 'string', enum: ['issue', 'recurring-issue'] },
      description: 'Object types to search. Omit to search both Issues and Recurring Issues.',
    },
    text: {
      type: 'string',
      minLength: 1,
      description: 'Full-text query against title, description, Activity summaries, and relevant output previews.',
    },
    filter: {
      type: 'object',
      additionalProperties: false,
      description: 'Structured predicates over durable fields, trigger readiness, session-derived state, and Activity-derived state.',
      properties: {
        ids: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Exact object ids.' },
        statusCategories: {
          type: 'array',
          items: { type: 'string', enum: ['triage', 'unstarted', 'started', 'completed', 'canceled', 'blocked', 'attention-needed', 'archived', 'scheduled'] },
          description: 'Stored lifecycle categories and derived projection buckets. Do not use UI view names as filters.',
        },
        delegateIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Delegates or agent profile ids to match.' },
        issueIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Exact concrete Issue ids.' },
        recurringIssueIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Exact Recurring Issue ids.' },
        parentIssueIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Parent Issue ids whose sub-issues should be listed.' },
        hasSubIssues: { type: 'boolean', description: 'Whether matching Issues must have visible sub-issues.' },
        triggerTypes: { type: 'array', items: { type: 'string', enum: ['manual', 'when-ready', 'scheduled'] }, description: 'Issue trigger types to match.' },
        dueDate: TIME_RANGE_SCHEMA,
        cadence: { type: 'array', items: { type: 'string', enum: ['daily', 'weekly', 'monthly'] }, description: 'Recurring Issue cadence types to match.' },
        nextMaterializationAt: TIME_RANGE_SCHEMA,
        relation: {
          type: 'object',
          additionalProperties: false,
          description: 'Relationship query for blocked-by, blocks, related, or duplicate-of links.',
          properties: {
            type: { type: 'string', enum: ['blocked-by', 'blocks', 'related', 'duplicate-of'], description: 'Relation kind to match.' },
            issueId: { type: 'string', minLength: 1, description: 'Optional related Issue id to match.' },
          },
        },
        archived: { type: 'boolean', description: 'Whether archived objects should be included or excluded.' },
        hasActiveSession: { type: 'boolean', description: 'Whether a pending or active Agent Session currently exists.' },
        needsAttention: { type: 'boolean', description: 'Whether user input, failed verification, failed execution, or a blocked dependency needs attention.' },
        inputNodeIds: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Input node ids to match.' },
        inputTags: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Input tag queries to match.' },
        sessionState: {
          type: 'array',
          items: { type: 'string', enum: ['pending', 'active', 'error', 'awaitingInput', 'complete', 'stale', 'canceled'] },
          description: 'Agent Session states projected onto Issues.',
        },
        activityTypes: {
          type: 'array',
          items: { type: 'string', enum: ['comment', 'field-change', 'status-change', 'agent-progress', 'agent-question', 'agent-action', 'agent-response', 'agent-error', 'verification-result', 'output-link'] },
          description: 'Activity content types to match.',
        },
        activityTarget: {
          type: 'object',
          additionalProperties: false,
          description: 'Activity target object for history searches around one Issue, Recurring Issue, or Agent Session.',
          properties: {
            type: { type: 'string', enum: ['issue', 'recurring-issue', 'agent-session'], description: 'Activity target kind.' },
            issueId: { type: 'string', minLength: 1, description: 'Issue id when type is issue.' },
            recurringIssueId: { type: 'string', minLength: 1, description: 'Recurring Issue id when type is recurring-issue.' },
            agentSessionId: { type: 'string', minLength: 1, description: 'Agent Session id when type is agent-session.' },
          },
        },
        createdAt: TIME_RANGE_SCHEMA,
        updatedAt: TIME_RANGE_SCHEMA,
      },
    },
    include: {
      type: 'array',
      items: { type: 'string', enum: ['activity-summary', 'session-summary', 'sub-issues-summary', 'criteria-summary', 'input-preview', 'output-preview', 'next-generated-issue'] },
      description: 'Optional summary slices to return with each row. Prefer summaries before full reads.',
    },
    orderBy: {
      type: 'array',
      description: 'Stable sort definitions. Omit for default relevance or system ordering.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string', enum: ['createdAt', 'updatedAt', 'dueDate', 'nextMaterializationAt', 'status'], description: 'Field to sort by.' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction. Defaults to desc where runtime has no better default.' },
        },
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum rows to return. Use small limits for selection.' },
    cursor: { type: 'string', minLength: 1, description: 'Pagination cursor returned by a previous search page.' },
  },
} as const;

export const ISSUE_READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['target'],
  properties: {
    target: TARGET_REF_SCHEMA,
    include: {
      type: 'array',
      items: { type: 'string', enum: ['definition', 'activity', 'sessions', 'sub-issues', 'criteria', 'progress', 'generated-issues', 'linked-notes', 'input-preview', 'output-preview', 'session-plan'] },
      description: 'Context slices to load. Omit for lightweight definition; include heavier slices only when needed.',
    },
  },
} as const;

export const ISSUE_CREATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['issueType', 'fields', 'request', 'reason'],
  properties: {
    issueType: {
      type: 'string',
      enum: ['issue', 'recurring-issue'],
      description: 'Use issue for one concrete unit of work and recurring-issue for a reusable cadence/template.',
    },
    fields: {
      type: 'object',
      additionalProperties: false,
      description: 'Durable definition fields. Required fields depend on issueType.',
      properties: {
        ...ISSUE_FIELDS_SCHEMA.properties,
        ...RECURRING_FIELDS_SCHEMA.properties,
      },
    },
    request: REQUEST_SCHEMA,
    reason: {
      type: 'string',
      minLength: 1,
      description: 'Short audit summary explaining why this object is being created.',
    },
  },
} as const;

export const ISSUE_UPDATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'change', 'request', 'reason'],
  properties: {
    target: TARGET_REF_SCHEMA,
    change: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      description: 'One explicit Issue-family change: patch, transition, pause/resume, skip-next, archive, or delete.',
      properties: {
        type: {
          type: 'string',
          enum: ['patch', 'transition', 'archive', 'delete', 'pause', 'resume', 'skip-next'],
          description: 'Change operation. pause/resume/skip-next apply only to Recurring Issues.',
        },
        patch: {
          type: 'object',
          additionalProperties: false,
          description: 'Durable field patch for a concrete Issue or Recurring Issue.',
          properties: {
            ...ISSUE_FIELDS_SCHEMA.properties,
            ...RECURRING_FIELDS_SCHEMA.properties,
          },
        },
        status: ISSUE_STATUS_SCHEMA,
      },
    },
    request: REQUEST_SCHEMA,
    reason: {
      type: 'string',
      minLength: 1,
      description: 'Short audit summary explaining why this object is being changed.',
    },
  },
} as const;

export const AGENT_SESSION_START_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['issueId', 'request', 'reason'],
  properties: {
    issueId: {
      type: 'string',
      minLength: 1,
      description: 'Existing concrete Issue to execute or orchestrate. Do not pass Recurring Issue ids.',
    },
    purpose: {
      type: 'string',
      enum: ['execute', 'verify'],
      description: 'Session purpose. Use execute for normal work and verify only when the Issue has an agent-review verification policy.',
    },
    expectedIssueRevision: {
      type: 'string',
      minLength: 1,
      description: 'Issue revision the caller expects to execute. Include it after issue_read.',
    },
    continuation: {
      type: 'object',
      additionalProperties: false,
      description: 'Link to a previous terminal or stale Agent Session for continue, retry, or revise intent.',
      properties: {
        previousAgentSessionId: { type: 'string', minLength: 1, description: 'Prior Agent Session id to continue from.' },
        intent: { type: 'string', enum: ['continue', 'retry', 'revise'], description: 'Semantic continuation intent.' },
        guidance: { type: 'string', description: 'New guidance for this continuation. Use issue_update for durable definition changes.' },
        context: { type: 'string', enum: ['summary', 'transcript', 'none'], description: 'Prior context detail to provide. Prefer summary unless transcript detail is necessary.' },
      },
    },
    detach: {
      type: 'boolean',
      description: 'Whether the caller wants the Session to continue in the background while the current conversation proceeds.',
    },
    executionPolicyOverride: {
      type: 'object',
      additionalProperties: false,
      description: 'Narrow execution-only override. It must not broaden the Issue durable permissions.',
      properties: {
        deadlineAt: { type: 'number', description: 'Execution-only deadline for this Session.' },
        retryPolicy: { type: 'string', enum: ['none', 'manual', 'bounded'], description: 'Execution-only retry behavior.' },
        maxAutomaticRetries: { type: 'integer', minimum: 0, description: 'Automatic retry cap when retryPolicy is bounded.' },
      },
    },
    request: REQUEST_SCHEMA,
    reason: { type: 'string', minLength: 1, description: 'Short audit summary explaining why this execution is being started.' },
  },
} as const;

export const AGENT_SESSION_READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['agentSessionId'],
  properties: {
    agentSessionId: { type: 'string', minLength: 1, description: 'Agent Session to inspect.' },
    wait: { type: 'boolean', description: 'Whether runtime may briefly wait for a state change or blocking question.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120000, description: 'Maximum wait time when wait is true. Runtime enforces this cap.' },
    include: {
      type: 'array',
      items: { type: 'string', enum: ['activity-summary', 'latest-output', 'blocking-question'] },
      description: 'Optional bounded detail slices to return.',
    },
  },
} as const;

export const AGENT_SESSION_SEND_MESSAGE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['agentSessionId', 'message', 'request', 'reason'],
  properties: {
    agentSessionId: { type: 'string', minLength: 1, description: 'Active or waiting Agent Session to receive the message.' },
    message: {
      type: 'string',
      minLength: 1,
      description: 'Guidance, clarification, or answer within the existing Issue definition.',
    },
    kind: {
      type: 'string',
      enum: ['guidance', 'answer'],
      description: 'Use answer for awaited input; use guidance for steering within the existing Issue definition.',
    },
    request: REQUEST_SCHEMA,
    reason: { type: 'string', minLength: 1, description: 'Short audit summary explaining why this message is being sent.' },
  },
} as const;

export const AGENT_SESSION_STOP_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['agentSessionId', 'request', 'reason'],
  properties: {
    agentSessionId: { type: 'string', minLength: 1, description: 'Pending or active Agent Session to cancel.' },
    request: REQUEST_SCHEMA,
    reason: { type: 'string', minLength: 1, description: 'Short audit summary explaining why execution should stop.' },
  },
} as const;

export const AGENT_ISSUE_TOOL_PARAMETER_SCHEMAS = {
  issue_search: ISSUE_SEARCH_PARAMETERS,
  issue_read: ISSUE_READ_PARAMETERS,
  issue_create: ISSUE_CREATE_PARAMETERS,
  issue_update: ISSUE_UPDATE_PARAMETERS,
  agent_session_start: AGENT_SESSION_START_PARAMETERS,
  agent_session_read: AGENT_SESSION_READ_PARAMETERS,
  agent_session_send_message: AGENT_SESSION_SEND_MESSAGE_PARAMETERS,
  agent_session_stop: AGENT_SESSION_STOP_PARAMETERS,
} as const;
