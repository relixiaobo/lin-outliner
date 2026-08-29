export type {
  AssetMetadata,
  AgentProviderConfigInput,
  AgentProviderConfigView,
  AgentProviderCapabilityModelOption,
  AgentModelOption,
  AgentProviderOption,
  AgentReasoningLevel,
  AgentRuntimeSettings,
  AgentRuntimeSettingsInput,
  AgentImageGenerationSettings,
  AgentImageGenerationSettingsInput,
  AgentSlashCommandView,
  AgentProviderSecretStatus,
  AgentProviderStoredApiKey,
  AgentEditorView,
  AgentEditableRole,
  AgentBuiltInDefinition,
  AgentCapabilityCatalog,
  AgentIdentityEntry,
  AgentPresentationOverrideRow,
  AgentProfileDraft,
  AgentProfileView,
  AgentRoleDraft,
  AgentProviderSettingsView,
  AgentProviderAuthKind,
  ProviderAuthView,
  OAuthLoginEvent,
  OAuthLoginEventEnvelope,
  SkillDefinition,
  SkillSourceKind,
  ManagedSkillCatalogView,
  ManagedSkillCommandResult,
  ManagedSkillDiscoveryCandidateView,
  ManagedSkillDiscoveryView,
  ManagedSkillErrorCode,
  ManagedSkillErrorView,
  ManagedSkillUpdatePreviewView,
  ManagedSkillView,
  Backlink,
  BatchMoveNodeInput,
  CommandResult,
  ContentBearingNodeProjection,
  CreateNodeTree,
  DocumentProjection,
  ProjectionUpdate,
  ProjectionSnapshot,
  AutoInitStrategy,
  FieldConfigPatch,
  FieldSlotMutation,
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
  TagTemplateBackfillPreview,
  TextMark,
  TextMarkKind,
  ViewFieldRef,
  ViewMode,
} from '../../core/types';

export type {
  AgentCoreMethod,
  AgentCoreNotification,
  AgentCoreRequestByMethod,
  AgentCoreResponseByMethod,
  AdditionalContext,
  RequestUserInputRequest,
  RequestUserInputResponse,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadItemEntry,
  ThreadSource,
  Turn,
  TurnId,
} from '../../core/agent/protocol';

export type { ThreadGoal, ThreadGoalStatus } from '../../core/agent/goal';

export interface AgentCapabilitySettingsView {
  blocks: string[];
  diagnostics: Array<{
    ruleValue: string;
    code: string;
    message: string;
  }>;
}

export interface AgentCapabilitySettingsPatchInput {
  removeBlocks: string[];
}

export {
  EMPTY_RICH_TEXT,
  isContentBearingNode,
  plainText,
  replaceAllRichTextPatch,
} from '../../core/types';
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
