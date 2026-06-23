export type {
  AssetMetadata,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentPermissionMode,
  AgentDelegationPermissionMode,
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
  AgentConversation,
  AgentCreateConversationOptions,
  AgentConversationListMeta,
  AgentMemoryEntryView,
  Backlink,
  BatchMoveNodeInput,
  CommandResult,
  CreateNodeTree,
  DocumentProjection,
  DocumentProjectionChangedEvent,
  ProjectionUpdate,
  ProjectionSnapshot,
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
  PasteRowMeta,
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
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentStorageLocation,
} from '../../core/agentTypes';

export type {
  AgentDreamReadiness,
  AgentRenderDreamTaskEntity,
} from '../../core/agentRenderProjection';

export interface AgentToolPermissionSettingsView {
  grants: string[];
  blocks: string[];
  softBlockAllows: string[];
  diagnostics: Array<{
    ruleValue: string;
    code: string;
    message: string;
  }>;
}

export interface AgentToolPermissionSettingsInput {
  grants: string[];
  blocks: string[];
  softBlockAllows: string[];
}

export interface AgentPickScopeFolderResult {
  canceled: boolean;
  path?: string;
  grant?: string;
  settings: AgentToolPermissionSettingsView;
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
