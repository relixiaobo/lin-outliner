import type {
  ThreadForkResponse as CanonicalThreadForkResponse,
  ThreadListResponse as CanonicalThreadListResponse,
  ThreadTurnDetailsReadResponse as CanonicalThreadTurnDetailsReadResponse,
  ThreadTurnsListResponse as CanonicalThreadTurnsListResponse,
  TurnStartResponse as CanonicalTurnStartResponse,
  TurnSubmitResponse as CanonicalTurnSubmitResponse,
  RendererAgentCoreNotification,
  RendererModelToolCallHistory,
  RendererProjection,
  RendererThread,
  RendererThreadItem,
  RendererTurn,
} from '../../core/agent/protocol';

export type AgentCoreNotification = RendererAgentCoreNotification;
export type Thread = RendererThread;
export type ThreadItem = RendererThreadItem;
export type Turn = RendererTurn;
export type ModelToolCallHistory = RendererModelToolCallHistory;
export type ThreadToolItem = Extract<RendererThreadItem, { readonly modelCall: RendererModelToolCallHistory }>;
export type ThreadForkResponse = RendererProjection<CanonicalThreadForkResponse>;
export type ThreadListResponse = RendererProjection<CanonicalThreadListResponse>;
export type ThreadTurnDetailsReadResponse = RendererProjection<CanonicalThreadTurnDetailsReadResponse>;
export type ThreadTurnsListResponse = RendererProjection<CanonicalThreadTurnsListResponse>;
export type TurnStartResponse = RendererProjection<CanonicalTurnStartResponse>;
export type TurnSubmitResponse = RendererProjection<CanonicalTurnSubmitResponse>;
