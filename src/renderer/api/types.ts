export type {
  AssetMetadata,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentPermissionMode,
  AgentModelOption,
  AgentProviderOption,
  AgentReasoningLevel,
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
  AgentSlashCommandView,
  AgentProviderSecretStatus,
  AgentProviderSettingsView,
  AgentProviderAuthKind,
  ProviderAuthView,
  OAuthLoginEvent,
  OAuthLoginEventEnvelope,
  AgentDefinition,
  SkillDefinition,
  AgentSession,
  AgentSessionMeta,
  Backlink,
  CommandOutcome,
  CreateNodeTree,
  DocumentProjection,
  DocumentProjectionChangedEvent,
  AutoInitStrategy,
  FieldConfigPatch,
  FieldType,
  FilterOperator,
  FilterValueLogic,
  FocusPlacement,
  FocusHint,
  FocusSurface,
  HideFieldMode,
  IconKind,
  InlineRef,
  InlineRefCursorBias,
  NodeId,
  NodeProjection,
  NodeType,
  ParsedPasteField,
  QueryLogic,
  QueryOp,
  ReferenceTarget,
  RichText,
  RichTextPatch,
  RichTextPatchOp,
  SearchHit,
  SplitNodeOptions,
  SortDirection,
  TagConfigPatch,
  TextMark,
  TextMarkKind,
  ViewFieldRef,
  ViewMode,
} from '../../core/types';

export type {
  AgentApprovalRequestView,
  AgentApprovalResolutionScope,
} from '../../core/agentTypes';

export interface AgentToolPermissionSettingsView {
  permissions: {
    allow: string[];
    ask: string[];
    deny: string[];
  };
  diagnostics: Array<{
    ruleValue: string;
    decision: 'allow' | 'ask' | 'deny';
    code: string;
    message: string;
  }>;
}

export { EMPTY_RICH_TEXT, plainText, replaceAllRichTextPatch } from '../../core/types';
export {
  inlineRefNodeId,
  nodeReferenceTarget,
  referenceTargetsEqual,
} from '../../core/types';
export {
  dateFieldEndpointDate,
  dateFieldEndpointHasTime,
  dateFieldEndpointTime,
  formatDateFieldEndpoint,
  formatDateFieldInput,
  formatDateFieldValue,
  normalizeDateFieldValue,
  normalizedDateFieldEndpoint,
  orderDateFieldEndpoints,
  parseDateFieldValue,
  parseDateFieldValueRange,
  type DateFieldValue,
  type DateFieldValueRange,
} from '../../core/dateFieldValue';
export {
  addLocalDays,
  isoLocalDate,
  offsetIsoLocalDate,
  parseIsoLocalDate,
  todayIsoLocalDate,
} from '../../core/localDate';
