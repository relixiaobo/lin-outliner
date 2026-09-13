/** Historical facts can be inspected, but their former execution claims are not renewed. */
export type RestoredWorkKind = 'task' | 'run' | 'goal' | 'session' | 'profile' | 'memory-job' | 'memory-publication' | 'thread';

export interface RestoredWorkAdmission {
  readonly generation: string | null;
  allows(kind: RestoredWorkKind, identity: string): boolean;
  blockedIdentities(kind: RestoredWorkKind): readonly string[];
  authorizeGoal(identity: string): Promise<void>;
  automaticSchedulingAllowed(): boolean;
}

export const UNRESTRICTED_RESTORED_WORK: RestoredWorkAdmission = {
  generation: null, allows: () => true, blockedIdentities: () => [], authorizeGoal: async () => undefined,
  automaticSchedulingAllowed: () => true,
};
