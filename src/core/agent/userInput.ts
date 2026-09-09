import type { UserInputIdentity } from './protocol';

export function userInputKey(identity: UserInputIdentity): string {
  return JSON.stringify([identity.hostGeneration, identity.threadId, identity.turnId, identity.itemId]);
}

export function sameUserInput(left: UserInputIdentity, right: UserInputIdentity): boolean {
  return left.hostGeneration === right.hostGeneration && left.threadId === right.threadId
    && left.turnId === right.turnId && left.itemId === right.itemId;
}
